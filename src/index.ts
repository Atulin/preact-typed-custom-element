import {
	type Attributes,
	type ComponentClass,
	type FunctionComponent,
	type FunctionalComponent,
	cloneElement,
	h,
	hydrate,
	render, VNode, Component
} from 'preact';
import type { ComponentType } from 'preact/compat';

type ComponentDefinition<TProps extends object> = (
	| FunctionComponent<TProps>
	| ComponentClass<TProps>
	| FunctionalComponent<TProps>
	) & {
	observedAttributes?: (keyof TProps)[];
	propTypes?: Record<keyof TProps, unknown>;
	tagName?: `${string}-${string}`;
};

type Options = { shadow: false | 'open' | 'closed' };

type PreactCustomElement<TProps extends object> = HTMLElement & {
	_root: ShadowRoot | HTMLElement;
	_vdomComponent: ComponentDefinition<TProps>;
	_vdom: ReturnType<typeof h> | null;
};

/**
 * ```ts
 * class PreactWebComponent extends Component {
 *   static tagName = 'my-web-component';
 *   render() {
 *     return <p>Hello world!</p>
 *   }
 * }
 *
 * register(PreactComponent);
 *
 * // use a preact component
 * function PreactComponent({ prop }) {
 *   return <p>Hello {prop}!</p>
 * }
 *
 * register(PreactComponent, 'my-component');
 * register(PreactComponent, 'my-component', ['prop']);
 * register(PreactComponent, 'my-component', ['prop'], {
 *   shadow: true,
 *   mode: 'closed'
 * });
 * ```
 */
export default function register<
	TProps extends object,
	T extends ComponentDefinition<TProps>,
>(
	Component: T,
	tagName?: `${string}-${string}`,
	propNames?: (keyof TProps)[],
	options?: Options
) {
	class PreactElement
		extends HTMLElement
		implements Partial<PreactCustomElement<TProps>> {
		_vdomComponent: ComponentDefinition<TProps>;
		_root: ShadowRoot | HTMLElement;
		_vdom: ReturnType<typeof h> | null = null;
		_props?: Partial<TProps>;

		static observedAttributes = propNames as string[];

		constructor() {
			super(); // Always call super() first in constructor

			this._vdomComponent = Component;
			this._root = options?.shadow
				? this.attachShadow({ mode: options.shadow || 'open' })
				: this;

			const propsToDefine =
				propNames || (PreactElement.observedAttributes as (keyof TProps)[]);

			for (const name of propsToDefine) {
				Object.defineProperty(this, name, {
					get() {
						return this._vdom ? this._vdom.props[name] : this._props?.[name];
					},
					set(v) {
						if (this._vdom) {
							// Directly call the class method
							this.attributeChangedCallback(String(name), null, v);
						} else {
							if (!this._props) this._props = {};
							this._props[name] = v;
						}

						// Reflect property changes to attributes if the value is a primitive
						if (
							v == null ||
							['string', 'boolean', 'number'].includes(typeof v)
						) {
							this.setAttribute(String(name), String(v));
						}
					},
					configurable: true,
					enumerable: true
				});
			}
		}

		connectedCallback() {
			const event = new CustomEvent('_preact', {
				detail: {} as Record<string, unknown>,
				bubbles: true,
				cancelable: true
			});
			this.dispatchEvent(event);
			const context = event.detail?.['context'];

			this._vdom = h(
				ContextProvider,
				{ ...this._props, context },
				toVdom(this, this._vdomComponent)
			);
			(this.hasAttribute('hydrate') ? hydrate : render)(this._vdom, this._root);
		}

		attributeChangedCallback(
			this: PreactCustomElement<{}>,
			name: string,
			oldValue: unknown,
			newValue: unknown
		) {
			if (!this._vdom) return;
			// Attributes use `null` as an empty value whereas `undefined` is more
			// common in pure JS components, especially with default parameters.
			// When calling `node.removeAttribute()` we'll receive `null` as the new
			// value. See issue #50.
			newValue = newValue == null ? undefined : newValue;
			const props: Record<string, unknown> = {};
			props[name] = newValue;
			props[toCamelCase(name)] = newValue;
			this._vdom = cloneElement(this._vdom, props);
			render(this._vdom, this._root);
		}

		disconnectedCallback() {
			render((this._vdom = null), this._root);
		}
	}

	return customElements.define(
		tagName ?? Component.tagName ?? Component.displayName ?? Component.name,
		PreactElement
	);
}

const ContextProvider: ComponentType<any> = function(this: Component, props) {
	this.getChildContext = () => props.context;
	// eslint-disable-next-line no-unused-vars
	const { context, children, ...rest } = props;
	return cloneElement(children, rest);
};

/**
 * Camel-cases a string
 * @param {string} str The string to transform to camelCase
 * @returns camel case version of the string
 */
function toCamelCase(str: string) {
	return str.replace(/-(\w)/g, (_, c) => (c ? c.toUpperCase() : ''));
}

/**
 * Pass an event listener to each `<slot>` that "forwards" the current
 * context value to the rendered child. The child will trigger a custom
 * event, where will add the context value to. Because events work
 * synchronously, the child can immediately pull of the value right
 * after having fired the event.
 */
const Slot: ComponentType<any> = function <T>(this: Component, props: T, context) {
	const ref = (r) => {
		if (!r) {
			this.ref.removeEventListener('_preact', this._listener);
		} else {
			this.ref = r;
			if (!this._listener) {
				this._listener = (event) => {
					event.stopPropagation();
					event.detail.context = context;
				};
				r.addEventListener('_preact', this._listener);
			}
		}
	};

	return h('slot', { ...props, ref });
};

const isComment = (node: Node): node is Comment => node.nodeType === 3;
const isElement = (node: Node): node is Element => node.nodeType === 1;

function toVdom(element: Node, nodeName: string | null): VNode<any> | string | null {
	if (isComment(element)) {
		return element.data;
	}
	if (!isElement(element)) {
		return null;
	}

	const children = [];
	const props: Record<string, string | VNode<any>> = {};
	const a = element.attributes;
	const cn = element.childNodes;


	for (const { name, value } of a) {
		if (name !== 'slot') {
			props[name] = value;
			props[toCamelCase(name)] = value;
		}
	}

	for (let i = cn.length; i--;) {
		const vnode = toVdom(cn[i], null);
		// Move slots correctly
		const name = cn[i].slot;
		if (name) {
			props[name] = h(Slot, { name } as Attributes, vnode);
		} else {
			children[i] = vnode;
		}
	}

	// Only wrap the topmost node with a slot
	const wrappedChildren = nodeName ? h(Slot, null, children) : children;
	return h(nodeName || element.nodeName.toLowerCase(), props, wrappedChildren);
}
