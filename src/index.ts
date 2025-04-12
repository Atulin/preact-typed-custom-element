import {
	type ComponentClass,
	type FunctionComponent,
	type FunctionalComponent,
	cloneElement,
	h,
	hydrate,
	render,
} from "preact";

type ComponentDefinition<TProps> = (
	| FunctionComponent<TProps>
	| ComponentClass<TProps>
	| FunctionalComponent<TProps>
) & {
	observedAttributes?: (keyof TProps)[];
	propTypes?: Record<keyof TProps, unknown>;
	tagName?: `${string}-${string}`;
};

type Options = { shadow: false } | { shadow: true; mode: "open" | "closed" };

type PreactCustomElement<TProps> = HTMLElement & {
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
export default function register<TProps, T extends ComponentDefinition<TProps>>(
	Component: T,
	tagName?: `${string}-${string}`,
	propNames?: (keyof TProps)[],
	options?: Options,
) {
	function PreactElement() {
		const inst: PreactCustomElement<TProps> = Reflect.construct(
			HTMLElement,
			[],
			PreactElement,
		);
		inst._vdomComponent = Component;
		inst._root =
			options && options.shadow
				? inst.attachShadow({ mode: options.mode || "open" })
				: inst;
		return inst;
	}

	PreactElement.prototype = Object.create(HTMLElement.prototype);
	PreactElement.prototype.constructor = PreactElement;
	PreactElement.prototype.connectedCallback = connectedCallback;
	PreactElement.prototype.attributeChangedCallback = attributeChangedCallback;
	PreactElement.prototype.disconnectedCallback = disconnectedCallback;

	if (!propNames && "observedAttributes" in Component) {
		propNames = Component.observedAttributes;
	} else if (!propNames && "propTypes" in Component) {
		propNames = Object.keys(Component.propTypes) as (keyof TProps)[];
	}

	PreactElement.observedAttributes = propNames;

	// Keep DOM properties and Preact props in sync
	for (const name of propNames) {
		Object.defineProperty(PreactElement.prototype, name, {
			get() {
				return this._vdom.props[name];
			},
			set(v) {
				if (this._vdom) {
					this.attributeChangedCallback(name, null, v);
				} else {
					if (!this._props) this._props = {};
					this._props[name] = v;
					this.connectedCallback();
				}

				// Reflect property changes to attributes if the value is a primitive
				if (v == null || ["string", "boolean", "number"].includes(typeof v)) {
					this.setAttribute(name, v);
				}
			},
		});
	}

	return customElements.define(
		tagName ?? Component.tagName ?? Component.displayName ?? Component.name,
		PreactElement,
	);
}

function ContextProvider(props) {
	this.getChildContext = () => props.context;
	// eslint-disable-next-line no-unused-vars
	const { context, children, ...rest } = props;
	return cloneElement(children, rest);
}

/**
 * @this {PreactCustomElement}
 */
function connectedCallback() {
	// Obtain a reference to the previous context by pinging the nearest
	// higher up node that was rendered with Preact. If one Preact component
	// higher up receives our ping, it will set the `detail` property of
	// our custom event. This works because events are dispatched
	// synchronously.
	const event = new CustomEvent("_preact", {
		detail: {},
		bubbles: true,
		cancelable: true,
	});

	this.dispatchEvent(event);
	const context = event.detail["context"];

	this._vdom = h(
		ContextProvider,
		{ ...this._props, context },
		toVdom(this, this._vdomComponent),
	);
	(this.hasAttribute("hydrate") ? hydrate : render)(this._vdom, this._root);
}

/**
 * Camel-cases a string
 * @param {string} str The string to transform to camelCase
 * @returns camel case version of the string
 */
function toCamelCase(str: string) {
	return str.replace(/-(\w)/g, (_, c) => (c ? c.toUpperCase() : ""));
}

/**
 * Changed whenever an attribute of the HTML element changed
 * @this {PreactCustomElement}
 * @param {string} name The attribute name
 * @param {unknown} oldValue The old value or undefined
 * @param {unknown} newValue The new value
 */
function attributeChangedCallback(
	name: string,
	oldValue: unknown,
	newValue: unknown,
) {
	if (!this._vdom) return;
	// Attributes use `null` as an empty value whereas `undefined` is more
	// common in pure JS components, especially with default parameters.
	// When calling `node.removeAttribute()` we'll receive `null` as the new
	// value. See issue #50.
	newValue = newValue == null ? undefined : newValue;
	const props = {};
	props[name] = newValue;
	props[toCamelCase(name)] = newValue;
	this._vdom = cloneElement(this._vdom, props);
	render(this._vdom, this._root);
}

/**
 * @this {PreactCustomElement}
 */
function disconnectedCallback() {
	render((this._vdom = null), this._root);
}

/**
 * Pass an event listener to each `<slot>` that "forwards" the current
 * context value to the rendered child. The child will trigger a custom
 * event, where will add the context value to. Because events work
 * synchronously, the child can immediately pull of the value right
 * after having fired the event.
 */
function Slot<T>(props: T, context) {
	const ref = (r) => {
		if (!r) {
			this.ref.removeEventListener("_preact", this._listener);
		} else {
			this.ref = r;
			if (!this._listener) {
				this._listener = (event) => {
					event.stopPropagation();
					event.detail.context = context;
				};
				r.addEventListener("_preact", this._listener);
			}
		}
	};
	return h("slot", { ...props, ref });
}

const isComment = (node: Node): node is Comment => node.nodeType === 3;
const isElement = (node: Node): node is Element => node.nodeType === 1;

function toVdom(element: Node, nodeName: string) {
	if (isComment(element)) {
		return element.data;
	}
	if (!isElement(element)) {
		return null;
	}

	const children = [];
	const props = {};
	const a = element.attributes;
	const cn = element.childNodes;

	for (let i = a.length; i--; ) {
		if (a[i].name !== "slot") {
			props[a[i].name] = a[i].value;
			props[toCamelCase(a[i].name)] = a[i].value;
		}
	}

	for (let i = cn.length; i--; ) {
		const vnode = toVdom(cn[i], null);
		// Move slots correctly
		const name = cn[i].slot;
		if (name) {
			props[name] = h(Slot, { name }, vnode);
		} else {
			children[i] = vnode;
		}
	}

	// Only wrap the topmost node with a slot
	const wrappedChildren = nodeName ? h(Slot, null, children) : children;
	return h(nodeName || element.nodeName.toLowerCase(), props, wrappedChildren);
}
