// Finds definitions in large JavaScript bundles.
//
// Parsing a whole bundle takes gigabytes, so a light scan records how the
// brackets nest and only the snippets that matter go through the real parser.

const REGEX_KEYWORDS = new Set([
    'return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'void', 'delete',
    'instanceof', 'new', 'throw', 'yield', 'await',
]);
const CONDITION_KEYWORDS = new Set(['if', 'while', 'for', 'with']);

const NEWLINE = 10;

const MAX_DEFINITIONS = 64;

const _isSpace = c => c === 32 || (c >= 9 && c <= 13);

const _isWord = c => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) ||
    (c >= 48 && c <= 57) || c === 95 || c === 36 || c > 127;

/**
 * Walks over the code from start, skipping strings, comments and regular
 * expressions.
 *
 * @param {string} text - the code
 * @param {number} start - where to start, which must not be inside a string
 * @param {object} visitor - open(pos, char), close(pos, char) and, if wanted,
 *   other(pos, char) for punctuation and newlines. Returning true stops.
 */
export function walk(text, start, visitor) {
    const length = text.length;
    const stack = []; // open brackets: [char, after a condition keyword]
    let regexAllowed = true;
    let lastWord = '';
    let i = start;

    const skipTemplate = pos => {
        // returns the position after the part, and whether an expression starts
        for (; pos < length; pos++) {
            const c = text.charCodeAt(pos);
            if (c === 92)
                pos++;
            else if (c === 96)
                return [pos + 1, false];
            else if (c === 36 && text.charCodeAt(pos + 1) === 123)
                return [pos + 2, true];
        }
        return [length, false];
    };

    while (i < length) {
        const c = text.charCodeAt(i);

        if (c === 32 || c === 9 || c === 13) {
            i++;
        } else if (c === NEWLINE) {
            if (visitor.other?.(i, '\n'))
                return;
            i++;
        } else if (_isWord(c)) {
            let end = i + 1;
            while (end < length && _isWord(text.charCodeAt(end)))
                end++;
            lastWord = end - i <= 10 ? text.slice(i, end) : '';
            // x.return is a property
            regexAllowed = REGEX_KEYWORDS.has(lastWord) && text[i - 1] !== '.';
            i = end;
            continue;
        } else if (c === 34 || c === 39) {
            let end = i + 1;
            while (end < length) {
                const s = text.charCodeAt(end);
                if (s === 92)
                    end++;
                else if (s === c || s === NEWLINE)
                    break;
                end++;
            }
            i = end + 1;
            regexAllowed = false;
        } else if (c === 96) {
            const [end, expression] = skipTemplate(i + 1);
            i = end;
            if (expression)
                stack.push(['`', false]);
            regexAllowed = expression;
        } else if (c === 47) {
            const next = text.charCodeAt(i + 1);
            if (next === 47) {
                const end = text.indexOf('\n', i);
                i = end === -1 ? length : end;
            } else if (next === 42) {
                const end = text.indexOf('*/', i + 2);
                i = end === -1 ? length : end + 2;
            } else if (regexAllowed) {
                let inClass = false;
                let end = i + 1;
                for (; end < length; end++) {
                    const r = text.charCodeAt(end);
                    if (r === 92)
                        end++;
                    else if (r === 91)
                        inClass = true;
                    else if (r === 93)
                        inClass = false;
                    else if (r === NEWLINE || (r === 47 && !inClass))
                        break;
                }
                i = end + 1;
                regexAllowed = false;
            } else {
                if (visitor.other?.(i, '/'))
                    return;
                i++;
                regexAllowed = true;
            }
        } else if (c === 40 || c === 91 || c === 123) {
            stack.push([text[i], c === 40 && CONDITION_KEYWORDS.has(lastWord)]);
            if (visitor.open?.(i, text[i]))
                return;
            i++;
            regexAllowed = true;
        } else if (c === 41 || c === 93 || c === 125) {
            const open = stack.pop();
            if (open?.[0] === '`') {
                const [end, expression] = skipTemplate(i + 1);
                i = end;
                if (expression)
                    stack.push(['`', false]);
                regexAllowed = expression;
            } else {
                if (visitor.close?.(i, text[i]))
                    return;
                i++;
                regexAllowed = c === 125 || (c === 41 && !!open?.[1]);
            }
        } else {
            if (visitor.other?.(i, text[i]))
                return;
            // x++ / y
            regexAllowed = !((c === 43 || c === 45) && text.charCodeAt(i - 1) === c);
            i++;
        }
        lastWord = '';
    }
}

/**
 * @param {string} code - an expression
 * @returns {object|null} its AST
 */
export function parseExpression(code) {
    for (const wrap of [c => `async function _(){return (${c}\n)}`, c => `async function _(){return ${c}\n}`]) {
        try {
            return Reflect.parse(wrap(code), {loc: false})
                .body[0].body.body[0].argument;
        } catch {
            // try the next one
        }
    }
    return null;
}

/**
 * @param {string} code - the statements of a function
 * @returns {object[]|null} their ASTs
 */
export function parseBody(code) {
    try {
        return Reflect.parse(`async function _(){${code}\n}`, {loc: false}).body[0].body.body;
    } catch {
        return null;
    }
}

export class Source {
    constructor(text) {
        this.text = text;
        this._definitions = new Map();

        const opens = [];
        const closes = [];
        const parents = [];
        const stack = [];
        walk(text, 0, {
            open: (pos, char) => {
                if (char !== '{')
                    return;
                parents.push(stack.at(-1) ?? -1);
                stack.push(opens.length);
                opens.push(pos);
                closes.push(text.length);
            },
            close: (pos, char) => {
                if (char === '}' && stack.length > 0)
                    closes[stack.pop()] = pos;
            },
        });
        this._opens = Int32Array.from(opens);
        this._closes = Int32Array.from(closes);
        this._parents = Int32Array.from(parents);
        // an unbalanced scan got confused somewhere
        this.balanced = stack.length === 0;
    }

    // Index of the innermost block around pos, -1 outside of any
    _blockAt(pos) {
        let low = 0;
        let high = this._opens.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (this._opens[mid] < pos)
                low = mid + 1;
            else
                high = mid;
        }
        let block = low - 1;
        while (block !== -1 && this._closes[block] < pos)
            block = this._parents[block];
        return block;
    }

    /**
     * @param {number} pos - a position in the code
     * @returns {string|null} the statements of the function around it
     */
    functionBodyAt(pos) {
        for (let block = this._blockAt(pos); block !== -1; block = this._parents[block]) {
            const open = this._opens[block];
            const before = this.text.slice(Math.max(0, open - 400), open).trimEnd();
            const isArrow = before.endsWith('=>');
            const isFunction = isArrow || (before.endsWith(')') &&
                !/(?:^|[^\w$.])(?:if|for|while|switch|catch|with)\s*\([^{}]*\)$/.test(before));
            if (isFunction)
                return this.text.slice(open + 1, this._closes[block]);
        }
        return null;
    }

    /**
     * Looks up what a name refers to.
     *
     * @param {string} name - an identifier
     * @param {number} pos - where it is used
     * @returns {{node: object, pos: number}|null} the AST of its value
     */
    lookup(name, pos) {
        let best = null;
        let bestStart = -2;
        for (const definition of this._findDefinitions(name)) {
            const block = this._blockAt(definition.pos);
            const start = block === -1 ? -1 : this._opens[block];
            if (start > pos || (block !== -1 && this._closes[block] < pos))
                continue;
            if (start > bestStart) {
                best = definition;
                bestStart = start;
            }
        }
        if (!best)
            return null;
        best.node ??= best.isFunction
            ? parseExpression(this._functionText(best.pos))
            : parseExpression(this._initializerText(best.valuePos));
        return best.node ? best : null;
    }

    _findDefinitions(name) {
        let found = this._definitions.get(name);
        if (found)
            return found;

        // indexOf() is many times faster than a regular expression here
        found = [];
        const {text} = this;
        for (let pos = text.indexOf(name); pos !== -1 && found.length < MAX_DEFINITIONS;
            pos = text.indexOf(name, pos + name.length)) {
            const before = pos > 0 ? text.charCodeAt(pos - 1) : 0;
            let end = pos + name.length;
            if (before === 46 || _isWord(before) || _isWord(text.charCodeAt(end)))
                continue;
            while (_isSpace(text.charCodeAt(end)))
                end++;

            const next = text.charCodeAt(end);
            if (next === 61) { // =, but neither == nor =>
                const after = text.charCodeAt(end + 1);
                if (after !== 61 && after !== 62)
                    found.push({pos, isFunction: false, valuePos: end + 1});
            } else if (next === 40) {
                const start = /(?:async\s+)?function\s*\*?\s*$/.exec(
                    text.slice(Math.max(0, pos - 24), pos));
                if (start)
                    found.push({pos: pos - start[0].length, isFunction: true});
            }
        }
        this._definitions.set(name, found);
        return found;
    }

    _functionText(pos) {
        let depth = 0;
        let end = pos;
        walk(this.text, pos, {
            open: () => {
                depth++;
            },
            close: (p, char) => {
                depth--;
                end = p + 1;
                return depth === 0 && char === '}';
            },
        });
        return this.text.slice(pos, end);
    }

    _initializerText(pos) {
        let depth = 0;
        let end = this.text.length;
        walk(this.text, pos, {
            open: () => {
                depth++;
            },
            close: p => {
                if (depth-- === 0) {
                    end = p;
                    return true;
                }
                return false;
            },
            other: (p, char) => {
                if (depth > 0)
                    return false;
                if (char === ',' || char === ';') {
                    end = p;
                    return true;
                }
                // without a semicolon, a line that could be complete is
                if (char === '\n' && !/^\s*(?:[.?:+*&|=<>([`]|-[^-])/.test(this.text.slice(p, p + 200)) &&
                    parseExpression(this.text.slice(pos, p))) {
                    end = p;
                    return true;
                }
                return false;
            },
        });
        return this.text.slice(pos, end);
    }
}
