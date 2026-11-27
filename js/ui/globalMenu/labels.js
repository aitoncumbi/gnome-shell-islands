/**
 * Removes the mnemonic from a menu label. CJK labels append it in brackets.
 *
 * @param {string|null} label - the label as exported
 * @returns {string} the label to show
 */
export function stripMnemonic(label) {
    return (label ?? '')
        .replace(/\s*\([_&][^_&)]\)(…|\.\.\.)?$/u, '$1')
        .replace(/_(.?)/gu, '$1');
}
