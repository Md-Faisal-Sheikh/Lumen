// Exercises the completion sanitizer against the failure modes it exists for.
import { looksLikeProse, sanitizeCompletion, stripPrefixEcho, stripSuffixEcho, unfence } from './completion'

let pass = 0
let fail = 0
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else {
    fail++
    console.log(`  FAIL ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`)
  }
}

console.log('unfence')
eq('plain text untouched', unfence('const a = 1'), 'const a = 1')
eq('fenced block extracted', unfence('Here you go:\n```js\nconst a = 1\n```'), 'const a = 1')
eq('unterminated fence', unfence('```js\nconst a = 1'), 'const a = 1')
eq('multi-line inside fence', unfence('```\na\nb\n```'), 'a\nb')

console.log('stripPrefixEcho')
eq('line restated', stripPrefixEcho('const total = items.length', 'const total = '), 'items.length')
eq('line restated, reindented', stripPrefixEcho('const total = 1', '  const total = '), '1')
eq('no overlap', stripPrefixEcho('items.length', 'const total = '), 'items.length')
eq('short coincidence kept', stripPrefixEcho('(x)', 'foo('), '(x)')
eq('long tail overlap', stripPrefixEcho('function greet() {}', 'x\nfunction greet'), '() {}')

console.log('stripSuffixEcho')
eq('duplicate brace', stripSuffixEcho('  return 1\n}', '\n}'), '  return 1')
eq('duplicate close tag', stripSuffixEcho('<b>hi</b></div>', '</div>'), '<b>hi</b>')
eq('no duplication', stripSuffixEcho('  return 1', '\n}'), '  return 1')
eq('whole thing is suffix', stripSuffixEcho('}', '}'), '')
// The case the indentation-sensitive comparison exists for: this `}` closes a
// block the completion itself opened, and is NOT the one sitting in the suffix.
eq('nested closer survives', stripSuffixEcho('if (x) {\n    go()\n  }', '\n}'), 'if (x) {\n    go()\n  }')
eq('deeper html closer survives', stripSuffixEcho('<ul>\n  <li>a</li>\n  </ul>', '\n</ul>'), '<ul>\n  <li>a</li>\n  </ul>')

console.log('sanitizeCompletion')
eq('empty', sanitizeCompletion('', 'x', ''), null)
eq('whitespace only', sanitizeCompletion('   \n  ', 'x', ''), null)
eq('trailing newline trimmed', sanitizeCompletion('items.length\n', 'const t = ', ''), 'items.length')
eq('leading newline dropped', sanitizeCompletion('\nitems.length', 'const t = ', ''), 'items.length')
eq('indentation preserved', sanitizeCompletion('    return 1', 'function f() {\n', '\n}'), '    return 1')
eq(
  'fence + echo + suffix dup together',
  sanitizeCompletion('```js\nconst total = items.length\n}\n```', 'const total = ', '\n}'),
  'items.length'
)
eq('suggestion identical to suffix', sanitizeCompletion('</div>', '<div>', '</div>'), null)
eq(
  'runaway answer clamped to 12 lines',
  sanitizeCompletion(Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n'), 'x = ', '')?.split('\n').length,
  12
)

// A reasoning model answering a completion request — the real captured failure.
// The primary fix is configuration (completion has its own instruct model); this
// is the guard for when someone points that setting at a thinking model anyway.
console.log('looksLikeProse')
const REASONING =
  'The user wants to sort the items array in ascending order. The prefix shows `const sorted = items.` ' +
  'and the suffix shows `console.log(sorted)`. The obvious completion is to call `.sort()`.'
eq('reasoning leak flagged', looksLikeProse(REASONING), true)
eq('  → sanitize drops it', sanitizeCompletion(REASONING, 'const sorted = items.', '\nconsole.log(sorted)\n'), null)
eq('another opening flagged', looksLikeProse('Okay, the caret is right after items. so we need a compare function.'), true)
// Real completions must survive, including the two that a code-punctuation
// density heuristic wrongly rejected before it was removed.
eq('short code', looksLikeProse('sort((a, b) => a - b)'), false)
eq('clamp body', looksLikeProse('return Math.min(Math.max(n, lo), hi);'), false)
eq('html block', looksLikeProse('<div class="card">\n  <h2>Title</h2>\n  <p>Body copy</p>\n</div>'), false)
eq('page copy survives', looksLikeProse('Our team has been building custom furniture for over thirty years in the same workshop'), false)
eq('long comment survives', looksLikeProse('// walk the list backwards so removing an item never shifts one we have not seen'), false)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
