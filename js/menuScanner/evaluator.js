// Works out what a piece of JavaScript evaluates to, as far as that can be
// told without running it. Nothing from the application is ever executed:
// this interprets the syntax tree, knows no real objects and has no way to
// reach the outside.
//
// Where the outcome is not known it assumes whatever yields more of a menu.

export const UNKNOWN = Symbol('unknown');

const MAX_STEPS = 400000;
const MAX_DEPTH = 80;
const MAX_ITERATIONS = 200;

// A function of the application
class Closure {
    constructor(node, env) {
        this.node = node;
        this.env = env;
    }
}

// The result of calling something unknown. Often a translation function or a
// wrapper, so what went in says something about what came out
export class UnknownCall {
    constructor(name, args) {
        this.name = name;
        this.args = args;
    }
}

class Env {
    constructor(parent, source, pos) {
        this.parent = parent;
        this.source = source ?? parent.source;
        this.pos = pos ?? parent.pos;
        this.vars = new Map();
    }

    find(name) {
        for (let env = this; env; env = env.parent) {
            if (env.vars.has(name))
                return env;
        }
        return null;
    }
}

class Return {
    constructor(value) {
        this.value = value;
    }
}

const _isUnknown = v => v === UNKNOWN || v instanceof UnknownCall;

// true, false, or undefined if it cannot be told
function _truth(v) {
    return _isUnknown(v) ? undefined : Boolean(v);
}

function _isObject(v) {
    return v !== null && typeof v === 'object' &&
        !Array.isArray(v) && !(v instanceof Closure) && !(v instanceof UnknownCall);
}

// app, or electron.app
function _isApp(node) {
    return (node?.property?.name ?? node?.name) === 'app';
}

/**
 * @param {any} v - a value
 * @returns {any[]|null} the array that it is, or was presumably made from
 */
export function asArray(v) {
    if (Array.isArray(v))
        return v;
    if (v instanceof UnknownCall) {
        for (const arg of v.args) {
            const array = asArray(arg);
            if (array)
                return array;
        }
    }
    return null;
}

/**
 * @param {any} v - a value
 * @returns {object|null} the object that it is, or was presumably made from
 */
export function asObject(v) {
    if (_isObject(v))
        return v;
    if (v instanceof UnknownCall)
        return v.args.map(asObject).find(o => o) ?? null;
    return null;
}

export class Evaluator {
    constructor(source, appName) {
        this._source = source;
        this._appName = appName;
        this._steps = 0;
        this._depth = 0;
        this._resolving = new Set();
        this._resolved = new Map();

        // the arguments of all buildFromTemplate() calls that were seen
        this.templates = [];
    }

    get exhausted() {
        return this._steps > MAX_STEPS;
    }

    /**
     * @param {object[]} statements - ASTs
     * @param {number} pos - where they are in the source
     */
    run(statements, pos) {
        this._steps = 0;
        this._block(statements, new Env(null, this._source, pos));
    }

    evaluate(node, pos) {
        this._steps = 0;
        return this._eval(node, new Env(null, this._source, pos));
    }

    // ---- statements ----

    _block(statements, env) {
        // function declarations are visible from the start
        for (const s of statements) {
            if (s?.type === 'FunctionDeclaration')
                env.vars.set(s.id.name, new Closure(s, env));
        }
        let fallback = null;
        for (const s of statements) {
            const result = this._statement(s, env);
            if (!result)
                continue;
            if (!result.maybe)
                return _isUnknown(result.value) && fallback ? fallback : result;
            // possibly not returned here, keep going to see what else there is
            fallback ??= result;
        }
        return fallback;
    }

    _statement(s, env) {
        if (!s || ++this._steps > MAX_STEPS)
            return null;

        switch (s.type) {
        case 'VariableDeclaration':
            for (const {id, init} of s.declarations)
                this._bind(id, init ? this._eval(init, env) : undefined, env);
            return null;
        case 'ExpressionStatement':
            this._eval(s.expression, env);
            return null;
        case 'ReturnStatement':
            return new Return(s.argument ? this._eval(s.argument, env) : undefined);
        case 'BlockStatement':
            return this._block(s.body, new Env(env));
        case 'IfStatement': {
            const truth = _truth(this._eval(s.test, env));
            if (truth !== undefined)
                return this._statement(truth ? s.consequent : s.alternate, env);
            const a = this._statement(s.consequent, env);
            const b = s.alternate ? this._statement(s.alternate, env) : null;
            const result = a && !_isUnknown(a.value) && a.value !== undefined ? a : b ?? a;
            if (result)
                result.maybe = !(a && b);
            return result;
        }
        case 'ForOfStatement': {
            const array = asArray(this._eval(s.right, env)) ?? [];
            for (const value of array.slice(0, MAX_ITERATIONS)) {
                const inner = new Env(env);
                const target = s.left.type === 'VariableDeclaration'
                    ? s.left.declarations[0].id : s.left;
                this._bind(target, value, inner);
                const result = this._statement(s.body, inner);
                if (result && !result.maybe)
                    return result;
            }
            return null;
        }
        case 'TryStatement':
            return this._statement(s.block, env);
        default:
            return null;
        }
    }

    _bind(pattern, value, env) {
        switch (pattern?.type) {
        case 'Identifier':
            env.vars.set(pattern.name, value);
            break;
        case 'AssignmentPattern':
        case 'AssignmentExpression':
            this._bind(pattern.left,
                value === undefined ? this._eval(pattern.right, env) : value, env);
            break;
        case 'ObjectPattern': {
            const object = asObject(value);
            for (const p of pattern.properties) {
                if (p.type === 'SpreadExpression' || !p.key)
                    continue;
                const key = p.key.name ?? p.key.value;
                const known = object && Object.hasOwn(object, key);
                // what is missing from a known object has its default
                this._bind(p.value, known ? object[key] : object ? undefined : UNKNOWN, env);
            }
            break;
        }
        case 'ArrayPattern':
            pattern.elements.forEach((e, i) => {
                const array = asArray(value);
                if (e)
                    this._bind(e, array ? array[i] : UNKNOWN, env);
            });
            break;
        }
    }

    // ---- expressions ----

    _eval(node, env) {
        if (!node)
            return undefined;
        if (++this._steps > MAX_STEPS || this._depth > MAX_DEPTH)
            return UNKNOWN;

        this._depth++;
        try {
            return this._evalNode(node, env);
        } finally {
            this._depth--;
        }
    }

    _evalNode(node, env) {
        switch (node.type) {
        case 'Literal':
            return node.value instanceof RegExp ? UNKNOWN : node.value;
        case 'Identifier':
            return this._identifier(node.name, env);
        case 'TemplateLiteral':
            return this._template(node, env);
        case 'ArrayExpression':
            return this._array(node.elements, env);
        case 'ObjectExpression':
            return this._object(node, env);
        case 'FunctionExpression':
        case 'ArrowFunctionExpression':
            return new Closure(node, env);
        case 'OptionalExpression':
            return this._eval(node.expression, env);
        case 'MemberExpression':
        case 'OptionalMemberExpression':
            return this._member(node, env);
        case 'CallExpression':
        case 'OptionalCallExpression':
            return this._callNode(node, env);
        case 'NewExpression':
            return this._newNode(node, env);
        case 'UnaryExpression':
            return this._unary(node, env);
        case 'BinaryExpression':
            return this._binary(node, env);
        case 'LogicalExpression':
            return this._logical(node, env);
        case 'ConditionalExpression':
            return this._conditional(node, env);
        case 'AssignmentExpression': {
            const value = this._eval(node.right, env);
            if (node.operator === '=' && node.left.type === 'Identifier') {
                const owner = env.find(node.left.name);
                owner?.vars.set(node.left.name, value);
            } else if (node.operator === '=' && node.left.type === 'MemberExpression') {
                const object = this._eval(node.left.object, env);
                const key = this._key(node.left, env);
                if (_isObject(object) && typeof key === 'string')
                    object[key] = value;
            }
            return value;
        }
        case 'SequenceExpression':
            return node.expressions.map(e => this._eval(e, env)).at(-1);
        default:
            return UNKNOWN;
        }
    }

    _identifier(name, env) {
        if (name === 'undefined')
            return undefined;
        const owner = env.find(name);
        if (owner)
            return owner.vars.get(name);

        const definition = env.source.lookup(name, env.pos);
        if (!definition)
            return UNKNOWN;
        const {node, pos} = definition;
        if (this._resolving.has(pos))
            return UNKNOWN;
        if (!this._resolved.has(pos)) {
            this._resolving.add(pos);
            const value = this._eval(node, new Env(null, env.source, pos));
            this._resolving.delete(pos);
            // not what came out of running out of depth
            if (value === UNKNOWN)
                return value;
            this._resolved.set(pos, value);
        }
        return this._resolved.get(pos);
    }

    _template(node, env) {
        let out = '';
        for (const e of node.elements) {
            const value = this._eval(e, env);
            if (_isUnknown(value) || (value !== null && typeof value === 'object'))
                return UNKNOWN;
            out += value;
        }
        return out;
    }

    _array(elements, env) {
        const out = [];
        for (const e of elements) {
            if (e?.type === 'SpreadExpression')
                out.push(...asArray(this._eval(e.expression, env)) ?? []);
            else
                out.push(this._eval(e, env));
        }
        return out;
    }

    _object(node, env) {
        const out = Object.create(null);
        for (const p of node.properties) {
            if (p.type === 'SpreadExpression') {
                const value = asObject(this._eval(p.expression, env));
                if (value)
                    Object.assign(out, value);
                continue;
            }
            if (p.kind === 'get' || p.kind === 'set' || !p.key)
                continue;
            const key = p.key.type === 'ComputedName'
                ? this._eval(p.key.name, env) : p.key.name ?? p.key.value;
            if (typeof key === 'string' || typeof key === 'number')
                out[key] = this._eval(p.value, env);
        }
        return out;
    }

    _key(node, env) {
        return node.computed ? this._eval(node.property, env) : node.property?.name;
    }

    _member(node, env) {
        const key = this._key(node, env);
        // well known, whatever they are a property of
        if (key === 'platform')
            return 'linux';
        if (key === 'isPackaged')
            return true;
        if (key === 'NODE_ENV')
            return 'production';

        const object = this._eval(node.object, env);
        if (Array.isArray(object)) {
            if (key === 'length')
                return object.length;
            return Number.isInteger(key) ? object[key] : UNKNOWN;
        }
        if (_isObject(object) && typeof key === 'string')
            return Object.hasOwn(object, key) ? object[key] : undefined;
        if (key === 'name' && _isApp(node.object))
            return this._appName;
        return UNKNOWN;
    }

    _unary(node, env) {
        const value = this._eval(node.argument, env);
        switch (node.operator) {
        case 'await':
            return value;
        case 'void':
            return undefined;
        case '!': {
            const truth = _truth(value);
            return truth === undefined ? UNKNOWN : !truth;
        }
        case '-':
            return typeof value === 'number' ? -value : UNKNOWN;
        default:
            return UNKNOWN;
        }
    }

    _binary(node, env) {
        const a = this._eval(node.left, env);
        const b = this._eval(node.right, env);
        if (_isUnknown(a) || _isUnknown(b))
            return UNKNOWN;
        const primitive = v => v === null || (typeof v !== 'object' && typeof v !== 'function');
        switch (node.operator) {
        case '===':
        case '==':
            return primitive(a) && primitive(b) ? a === b : UNKNOWN;
        case '!==':
        case '!=':
            if (node.operator === '!=' && (a ?? null) === null && (b ?? null) === null)
                return false;
            return primitive(a) && primitive(b) ? a !== b : UNKNOWN;
        case '+':
            return primitive(a) && primitive(b) ? a + b : UNKNOWN;
        default:
            return UNKNOWN;
        }
    }

    _logical(node, env) {
        const a = this._eval(node.left, env);
        const truth = _truth(a);
        if (node.operator === '&&') {
            if (truth === false)
                return a;
            return this._eval(node.right, env);
        }
        if (node.operator === '??')
            return _isUnknown(a) || a === null || a === undefined ? this._eval(node.right, env) : a;
        if (truth === true)
            return a;
        const b = this._eval(node.right, env);
        return truth === undefined && _isUnknown(b) ? a : b;
    }

    _conditional(node, env) {
        const truth = _truth(this._eval(node.test, env));
        if (truth !== undefined)
            return this._eval(truth ? node.consequent : node.alternate, env);

        const a = this._eval(node.consequent, env);
        const b = this._eval(node.alternate, env);
        if (_isUnknown(a) || a === null || a === undefined)
            return b;
        // "on a Mac, or else"
        if (typeof a === 'string' && typeof b === 'string' &&
            /\b(?:Cmd|Command|Option)\b/.test(a) && !/\b(?:Cmd|Command|Option)\b/.test(b))
            return b;
        if (Array.isArray(a) && Array.isArray(b) && b.length > a.length)
            return b;
        return a;
    }

    _newNode(node, env) {
        const name = node.callee?.property?.name ?? node.callee?.name;
        const args = this._array(node.arguments, env);
        // a MenuItem is as good as its options
        if (name === 'MenuItem' && _isObject(args[0]))
            return args[0];
        return new UnknownCall(name, []);
    }

    _callNode(node, env) {
        const {callee} = node;
        const isMember = callee.type === 'MemberExpression' ||
            callee.type === 'OptionalMemberExpression';
        const args = this._array(node.arguments, env);

        if (isMember) {
            const name = this._key(callee, env);
            if (name === 'buildFromTemplate') {
                this.templates.push(args[0]);
                return args[0];
            }
            if (name === 'isArray')
                return _isUnknown(args[0]) ? UNKNOWN : Array.isArray(args[0]);
            if (name === 'platform')
                return 'linux';
            if (name === 'getName' && _isApp(callee.object))
                return this._appName;
            // react-intl and friends carry their English text
            const message = _isObject(args[0]) ? args[0].defaultMessage : undefined;
            if (typeof message === 'string')
                return this._format(message, args[1]);

            const object = this._eval(callee.object, env);
            const array = this._arrayMethod(object, name, args);
            if (array !== UNKNOWN)
                return array;
            if (_isObject(object) && object[name] instanceof Closure)
                return this._call(object[name], args);
            return new UnknownCall(name, args);
        }

        const fn = this._eval(callee, env);
        if (fn instanceof Closure) {
            const value = this._call(fn, args);
            // at least it can be told what went in
            return value === UNKNOWN ? new UnknownCall(callee.name, args) : value;
        }
        return new UnknownCall(callee.name, args);
    }

    _format(message, values) {
        return message.replace(/\{(\w+)\}/g, (whole, key) =>
            typeof values?.[key] === 'string' ? values[key] : '').trim();
    }

    _arrayMethod(object, name, args) {
        const array = asArray(object);
        if (!array)
            return UNKNOWN;

        const [fn] = args;
        switch (name) {
        case 'push':
        case 'unshift':
            array[name](...args);
            return array.length;
        case 'splice':
            if (Number.isInteger(args[0]) && Number.isInteger(args[1]))
                return array.splice(...args);
            return UNKNOWN;
        case 'concat':
            return array.concat(...args.map(a => asArray(a) ?? a));
        case 'map':
        case 'flatMap': {
            if (!(fn instanceof Closure))
                return array;
            const out = array.slice(0, MAX_ITERATIONS).map((v, i) => this._call(fn, [v, i]));
            return name === 'flatMap' ? out.flat() : out;
        }
        case 'filter':
            if (!(fn instanceof Closure))
                return array.filter(v => _truth(v) !== false);
            return array.slice(0, MAX_ITERATIONS)
                .filter((v, i) => _truth(this._call(fn, [v, i])) !== false);
        case 'forEach':
            if (fn instanceof Closure)
                array.slice(0, MAX_ITERATIONS).forEach((v, i) => this._call(fn, [v, i]));
            return undefined;
        case 'flat':
            return array.flat();
        case 'slice':
            return args.every(a => a === undefined || Number.isInteger(a))
                ? array.slice(...args) : array;
        case 'join':
            return array.every(v => typeof v === 'string') ? array.join(args[0]) : UNKNOWN;
        default:
            return UNKNOWN;
        }
    }

    _call(closure, args) {
        const {node} = closure;
        if (this._depth > MAX_DEPTH)
            return UNKNOWN;

        const env = new Env(closure.env);
        node.params.forEach((param, i) => {
            let value = args[i];
            if (value === undefined && node.defaults?.[i])
                value = this._eval(node.defaults[i], env);
            this._bind(param, value, env);
        });
        if (node.rest)
            this._bind(node.rest, args.slice(node.params.length), env);

        this._depth++;
        try {
            if (node.body.type !== 'BlockStatement')
                return this._eval(node.body, env);
            const result = this._block(node.body.body, env);
            return result ? result.value : undefined;
        } finally {
            this._depth--;
        }
    }
}
