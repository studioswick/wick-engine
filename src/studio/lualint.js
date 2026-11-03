// Lua tokenizer, small syntax checker and hint rules for the script editor. Pure text in, data out (no DOM), so it also
// runs headless.
//
// analyze(text) returns { tokens, diagnostics }. A diagnostic is { s, e, kind, msg, fix } where s and e are character
// offsets, kind is 'fix' (a mistake with a safe replacement, blue wavy line), 'error' (red wavy line) or 'tip' (works,
// but there is a plainer way, blue straight line), and fix is { s, e, text, label } or null.

const KEYWORDS = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while']);
export const BUILTINS = new Set(['print', 'warn', 'assert', 'error', 'pcall', 'xpcall', 'select', 'tonumber', 'tostring', 'type', 'typeof', 'ipairs', 'pairs', 'next', 'rawget', 'rawset', 'rawequal', 'rawlen', 'setmetatable', 'getmetatable', 'unpack', 'collectgarbage', 'math', 'string', 'table', 'utf8', 'coroutine', 'os', 'task', 'game', 'workspace', 'script', 'Instance', 'Vector3', 'Vector2', 'Color3', 'UDim2', 'TweenInfo', '_G']);

// Luau and C habits that Lua does not have. Longest first, so '..=' wins over '..'.
const LUAU_OPS = ['..=', '//=', '+=', '-=', '*=', '/=', '%=', '^=', '!=', '&&', '||', '++'];
const COMPOUND = new Set(['+=', '-=', '*=', '/=', '%=', '^=', '..=', '//=']);
const OPS = ['...', '..', '==', '~=', '<=', '>=', '//', '<<', '>>', '::'];
const SINGLE = new Set('+-*/%^#&~|<>=(){}[];:,.!'.split(''));

const isDigit = (c) => c >= '0' && c <= '9';
const isNameStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isNameChar = (c) => isNameStart(c) || isDigit(c);

// ---------------------------------------------------------------------------------------------
// Tokenizer. Every character of the text belongs to exactly one token (whitespace included).
// t: ws | cmt | str | num | name | kw | op | bad
// ---------------------------------------------------------------------------------------------

function longBracket(text, i) {
  const m = /^\[(=*)\[/.exec(text.slice(i, i + 66));
  return m ? m[1].length : -1;
}

export function tokenize(text, diagnostics = []) {
  const tokens = [];
  let i = 0, line = 1;
  const push = (t, s, e, extra) => {
    const tok = { t, v: text.slice(s, e), s, e, line, ...extra };
    tokens.push(tok);
    for (let k = s; k < e; k++) if (text[k] === '\n') line++;
    return tok;
  };
  const problem = (s, e, msg) => diagnostics.push({ s, e: Math.max(e, s + 1), kind: 'error', msg, fix: null });

  while (i < text.length) {
    const c = text[i];
    if (c === '\n' || c === ' ' || c === '\t' || c === '\r') {
      let j = i;
      while (j < text.length && ' \t\r\n'.includes(text[j])) j++;
      push('ws', i, j);
      i = j;
    } else if (c === '-' && text[i + 1] === '-') {
      const level = text[i + 2] === '[' ? longBracket(text, i + 2) : -1;
      let j;
      if (level >= 0) {
        const close = `]${'='.repeat(level)}]`;
        const end = text.indexOf(close, i + 4 + level);
        j = end < 0 ? text.length : end + close.length;
        if (end < 0) problem(i, i + 2, 'Syntax error: this comment starts with --[[ but is never closed with ]].');
      } else {
        j = text.indexOf('\n', i);
        if (j < 0) j = text.length;
      }
      push('cmt', i, j);
      i = j;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      if (text[j] !== c) { problem(i, Math.min(j, text.length), `Syntax error: this string is missing its closing ${c}.`); j = Math.min(j, text.length); } else j++;
      push('str', i, j);
      i = j;
    } else if (c === '`') {
      let j = text.indexOf('`', i + 1);
      const nl = text.indexOf('\n', i);
      if (j < 0 || (nl >= 0 && nl < j)) j = nl < 0 ? text.length : nl; else j++;
      problem(i, j, 'Syntax error: backtick strings do not exist in Lua. Use "text" and join pieces with .. (for example "Score: " .. score).');
      push('str', i, j);
      i = j;
    } else if (c === '[' && longBracket(text, i) >= 0) {
      const level = longBracket(text, i);
      const close = `]${'='.repeat(level)}]`;
      const end = text.indexOf(close, i + level + 2);
      const j = end < 0 ? text.length : end + close.length;
      if (end < 0) problem(i, i + level + 2, 'Syntax error: this long string is never closed.');
      push('str', i, j);
      i = j;
    } else if (isDigit(c) || (c === '.' && isDigit(text[i + 1] ?? ''))) {
      const m = /^(0[xX](?=[0-9a-fA-F.])[0-9a-fA-F]*\.?[0-9a-fA-F]*([pP][+-]?\d+)?|\d*\.?\d*([eE][+-]?\d+)?)/.exec(text.slice(i, i + 80));
      let j = i + m[0].length;
      while (j < text.length && isNameChar(text[j])) j++;
      if (j > i + m[0].length) problem(i, j, `Syntax error: "${text.slice(i, j)}" is not a valid number.`);
      push('num', i, j);
      i = j;
    } else if (isNameStart(c)) {
      let j = i + 1;
      while (j < text.length && isNameChar(text[j])) j++;
      const word = text.slice(i, j);
      push(KEYWORDS.has(word) ? 'kw' : 'name', i, j);
      i = j;
    } else {
      const luau = LUAU_OPS.find((o) => text.startsWith(o, i));
      const op = luau ?? OPS.find((o) => text.startsWith(o, i)) ?? (SINGLE.has(c) ? c : null);
      if (!op) {
        problem(i, i + 1, `Syntax error: the character "${c}" is not allowed in Lua code.`);
        push('bad', i, i + 1);
        i++;
        continue;
      }
      push('op', i, i + op.length, luau ? { luau: true } : undefined);
      i += op.length;
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Parser. Checks the grammar only (no values), stops at the first real error like Lua does.
// ---------------------------------------------------------------------------------------------

class Stop extends Error {
  constructor(tok, msg, fix = null) { super(msg); this.tok = tok; this.fix = fix; }
}

const BLOCK_END = new Set(['end', 'else', 'elseif', 'until']);
const BINARY = { 'or': [1, 1], 'and': [2, 2], '<': [3, 3], '>': [3, 3], '<=': [3, 3], '>=': [3, 3], '~=': [3, 3], '==': [3, 3], '|': [4, 4], '~': [5, 5], '&': [6, 6], '<<': [7, 7], '>>': [7, 7], '..': [9, 8], '+': [10, 10], '-': [10, 10], '*': [11, 11], '/': [11, 11], '//': [11, 11], '%': [11, 11], '^': [14, 13] };
const UNARY_PRIORITY = 12;

/** The word Lua would see for a token: Luau and C spellings are mapped to their Lua meaning (and reported elsewhere). */
function word(tok) {
  if (tok.t === 'op' && tok.luau) return { '!=': '~=', '&&': 'and', '||': 'or' }[tok.v] ?? tok.v;
  if (tok.t === 'op' && tok.v === '!') return 'not';
  return tok.v;
}

function parseTokens(tokens, text, diagnostics) {
  const T = tokens.filter((t) => t.t !== 'ws' && t.t !== 'cmt');
  const eof = { t: 'eof', v: '', s: text.length, e: text.length, line: (text.match(/\n/g)?.length ?? 0) + 1 };
  T.push(eof);
  let i = 0;
  let binaryCount = 0;
  const peek = (n = 0) => T[Math.min(i + n, T.length - 1)];
  const is = (v, n = 0) => { const t = peek(n); return t.t !== 'str' && t.t !== 'eof' && t.t !== 'num' && word(t) === v; };
  const near = (t) => (t.t === 'eof' ? 'the end of the script' : `'${t.v.length > 24 ? `${t.v.slice(0, 24)}...` : t.v}'`);
  const next = () => T[i++];
  const prevTok = () => T[Math.max(0, i - 1)];
  const accept = (v) => { if (is(v)) { i++; return true; } return false; };

  const insertFix = (tok, insert, label) => ({ s: tok.e, e: tok.e, text: insert, label });

  function expect(v, hint) {
    if (is(v)) return next();
    const t = peek();
    if ((v === 'then' || v === 'do') && is('=')) {
      throw new Stop(t, `Syntax error: '${v}' expected near '='. To compare two values write '==' (a single '=' is for assigning).`, { s: t.s, e: t.e, text: '==', label: "Replace '=' with '=='" });
    }
    if (v === 'then' || v === 'do') {
      const before = prevTok();
      throw new Stop(before, `Syntax error: '${v}' is missing after ${v === 'then' ? 'the if condition' : 'the loop header'}.`, insertFix(before, ` ${v}`, `Add '${v}'`));
    }
    throw new Stop(t, hint ?? `Syntax error: '${v}' expected near ${near(t)}.`);
  }

  function expectEnd(opener, closer = 'end') {
    if (is(closer)) return next();
    const t = peek();
    if (t.t === 'eof') {
      throw new Stop(opener, `Syntax error: this '${opener.v}' (line ${opener.line}) is never closed. Add '${closer}' where it should stop.`, { s: text.length, e: text.length, text: `${text.endsWith('\n') || text === '' ? '' : '\n'}${closer}\n`, label: `Add '${closer}' at the end` });
    }
    throw new Stop(t, `Syntax error: '${closer}' expected near ${near(t)} to close the '${opener.v}' on line ${opener.line}.`);
  }

  function name(what = 'a name') {
    const t = peek();
    if (t.t === 'name') return next();
    throw new Stop(t, `Syntax error: ${what} is expected near ${near(t)}.`);
  }

  // A Luau type annotation (": number", ": Vector3?") after a name: reported with a fix that deletes it.
  function skipType() {
    if (!is(':') || peek(1).t !== 'name') return;
    const colon = peek();
    i++;
    let end = next();
    while (is('.') && peek(1).t === 'name') { i++; end = next(); }
    if (is('?')) end = next();
    diagnostics.push({ s: colon.s, e: end.e, kind: 'fix', msg: 'Type annotations do not exist in Lua. Remove the type.', fix: { s: colon.s, e: end.e, text: '', label: 'Remove the type' } });
  }

  function block() {
    for (;;) {
      const t = peek();
      if (t.t === 'eof' || (t.t === 'kw' && BLOCK_END.has(t.v))) return;
      if (is('return')) {
        next();
        const f = peek();
        if (!(f.t === 'eof' || (f.t === 'kw' && BLOCK_END.has(f.v)) || is(';'))) exprlist();
        accept(';');
        const after = peek();
        if (!(after.t === 'eof' || (after.t === 'kw' && BLOCK_END.has(after.v)))) throw new Stop(after, "Syntax error: 'return' has to be the last line of its block. Code after it can never run.");
        return;
      }
      statement();
    }
  }

  function statement() {
    const t = peek();
    if (is(';')) { i++; return; }
    if (t.t === 'kw') {
      switch (t.v) {
        case 'if': {
          i++;
          expr(); expect('then'); block();
          while (is('elseif')) { i++; expr(); expect('then'); block(); }
          if (accept('else')) block();
          expectEnd(t);
          return;
        }
        case 'while': i++; expr(); expect('do'); block(); expectEnd(t); return;
        case 'do': i++; block(); expectEnd(t); return;
        case 'for': {
          i++;
          name();
          if (is('=')) { i++; expr(); expect(','); expr(); if (accept(',')) expr(); } else {
            while (accept(',')) name();
            expect('in', `Syntax error: 'in' or '=' expected near ${near(peek())} in this for loop.`);
            exprlist();
          }
          expect('do'); block(); expectEnd(t);
          return;
        }
        case 'repeat': i++; block(); expectEnd(t, 'until'); expr(); return;
        case 'function': {
          i++;
          name('the function name');
          while (is('.') || is(':')) { const colon = is(':'); i++; name(); if (colon) break; }
          funcBody(t);
          return;
        }
        case 'local': {
          i++;
          if (accept('function')) { name('the function name'); funcBody(t); return; }
          do {
            name('a variable name');
            if (accept('<')) { name('an attribute'); expect('>'); }
            skipType();
          } while (accept(','));
          if (accept('=')) exprlist();
          return;
        }
        case 'break': i++; return;
        case 'goto': i++; name('a label name'); return;
        default: break;
      }
    }
    if (is('::')) { i++; name('a label name'); expect('::'); return; }
    exprStatement();
  }

  function exprStatement() {
    const first = peek();
    const startIdx = i;
    const e = suffixedExpr();
    if (is('=') || is(',')) {
      if (!e.assignable) throw new Stop(first, `Syntax error: you cannot assign to this. The left side of '=' must be a variable or a field, like x or part.Size.`);
      while (accept(',')) { const more = suffixedExpr(); if (!more.assignable) throw new Stop(prevTok(), 'Syntax error: you cannot assign to this.'); }
      expect('=', `Syntax error: '=' expected near ${near(peek())}. To set a variable write: name = value.`);
      exprlist();
      return;
    }
    const op = peek();
    if (op.t === 'op' && op.luau && COMPOUND.has(op.v) && e.assignable) {
      i++;
      const rhsStart = peek();
      const wrapped = expr();
      const rhsEnd = prevTok();
      const lhsText = text.slice(first.s, op.s).trimEnd();
      const rhsText = text.slice(rhsStart.s, rhsEnd.e);
      const bin = op.v.slice(0, -1);
      const body = wrapped ? `(${rhsText})` : rhsText;
      diagnostics.push({ s: op.s, e: op.e, kind: 'fix', msg: `Lua has no '${op.v}'. Write the whole assignment instead.`, fix: { s: first.s, e: rhsEnd.e, text: `${lhsText} = ${lhsText} ${bin} ${body}`, label: `Write ${lhsText} = ${lhsText} ${bin} ...` } });
      return;
    }
    if (op.t === 'op' && op.v === '++' && e.assignable) {
      i++;
      const lhsText = text.slice(first.s, op.s).trimEnd();
      diagnostics.push({ s: op.s, e: op.e, kind: 'fix', msg: "Lua has no '++'. Add one with a normal assignment.", fix: { s: first.s, e: op.e, text: `${lhsText} = ${lhsText} + 1`, label: `Write ${lhsText} = ${lhsText} + 1` } });
      return;
    }
    if (e.call) return;
    if (first.t === 'name' && first.v === 'continue' && i === startIdx + 1) {
      diagnostics.push({ s: first.s, e: first.e, kind: 'error', msg: "Syntax error: 'continue' does not exist in Lua. Write 'goto continue' here and put '::continue::' as the last line of the loop.", fix: null });
      return;
    }
    const bad = e.assignable ? peek() : first;
    throw new Stop(bad, e.assignable
      ? `Syntax error: '=' expected near ${near(peek())}. A line that starts with a name must set it (x = 5) or call it (x()).`
      : `Syntax error: unexpected symbol near ${near(first)}. A line should be a call like print(1), an assignment like x = 1, or start with if / for / while / local / function / return.`);
  }

  function funcBody(opener) {
    expect('(', `Syntax error: '(' expected near ${near(peek())} after the function name.`);
    if (!is(')')) {
      do {
        if (accept('...')) break;
        name('a parameter name');
        skipType();
      } while (accept(','));
    }
    expect(')', `Syntax error: ')' expected near ${near(peek())} to close the parameter list.`);
    skipType();
    block();
    expectEnd(opener);
  }

  function exprlist() {
    expr();
    while (accept(',')) expr();
  }

  /** Parses an expression; true when it used an operator at its top level (so it needs brackets inside a larger one). */
  function expr(limit = 0) {
    const before = binaryCount;
    if (is('not') || is('-') || is('#') || is('~')) { i++; binaryCount++; expr(UNARY_PRIORITY); } else simpleExpr();
    for (;;) {
      const op = peek();
      const w = op.t === 'op' || op.t === 'kw' ? word(op) : null;
      const pri = w && BINARY[w];
      if (!pri || pri[0] <= limit) break;
      i++;
      binaryCount++;
      expr(pri[1]);
    }
    return binaryCount > before;
  }

  function simpleExpr() {
    const t = peek();
    if (t.t === 'num' || t.t === 'str') { i++; return; }
    if (t.t === 'kw' && (t.v === 'nil' || t.v === 'true' || t.v === 'false')) { i++; return; }
    if (is('...')) { i++; return; }
    if (is('{')) { tableConstructor(); return; }
    if (is('function')) { i++; funcBody(t); return; }
    if (is('if')) throw new Stop(t, "Syntax error: 'if' cannot be used inside an expression in Lua. Use an if statement that sets the variable, or write (a and b or c).");
    suffixedExpr();
  }

  function tableConstructor() {
    const open = next();
    while (!is('}')) {
      if (peek().t === 'eof') throw new Stop(open, `Syntax error: this '{' (line ${open.line}) is never closed with '}'.`);
      if (is('[')) { i++; expr(); expect(']'); expect('='); expr(); } else if (peek().t === 'name' && is('=', 1)) { i += 2; expr(); } else expr();
      if (!accept(',') && !accept(';')) break;
    }
    if (!is('}')) throw new Stop(peek().t === 'eof' ? open : peek(), peek().t === 'eof' ? `Syntax error: this '{' (line ${open.line}) is never closed with '}'.` : `Syntax error: '}' expected near ${near(peek())} to close the '{' on line ${open.line}. Items are separated with commas.`);
    i++;
  }

  /** Returns { assignable, call } describing what was parsed. */
  function suffixedExpr() {
    const t = peek();
    let assignable = false, call = false;
    if (t.t === 'name') { i++; assignable = true; } else if (is('(')) {
      i++;
      expr();
      if (!is(')')) throw new Stop(peek().t === 'eof' ? t : peek(), `Syntax error: ')' expected near ${near(peek())} to close the '(' on line ${t.line}.`);
      i++;
    } else {
      throw new Stop(t, `Syntax error: unexpected symbol near ${near(t)}.${t.t === 'kw' && BLOCK_END.has(t.v) ? ` '${t.v}' has nothing to close here.` : ''}`);
    }
    for (;;) {
      if (is('.')) { i++; name('a field name'); assignable = true; call = false; } else if (is('[')) {
        const open = next();
        expr();
        if (!is(']')) throw new Stop(peek().t === 'eof' ? open : peek(), `Syntax error: ']' expected near ${near(peek())} to close the '[' on line ${open.line}.`);
        i++; assignable = true; call = false;
      } else if (is(':')) {
        if (peek(1).t !== 'name') break;
        i++; name(); callArgs(); assignable = false; call = true;
      } else if (is('(') || is('{') || peek().t === 'str') {
        callArgs(); assignable = false; call = true;
      } else break;
    }
    return { assignable, call };
  }

  function callArgs() {
    const t = peek();
    if (t.t === 'str') { i++; return; }
    if (is('{')) { tableConstructor(); return; }
    if (!is('(')) throw new Stop(t, `Syntax error: function arguments expected near ${near(t)}.`);
    i++;
    if (!is(')')) exprlist();
    if (!is(')')) throw new Stop(peek().t === 'eof' ? t : peek(), `Syntax error: ')' expected near ${near(peek())} to close the '(' on line ${t.line}. Arguments are separated with commas.`);
    i++;
  }

  try {
    block();
    if (peek().t !== 'eof') {
      const t = peek();
      throw new Stop(t, `Syntax error: '${t.v}' has nothing to close. Remove it, or check the blocks above it.`, { s: t.s, e: t.e, text: '', label: `Remove this '${t.v}'` });
    }
  } catch (err) {
    if (!(err instanceof Stop)) throw err;
    return err;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Hint rules (token patterns that are plain mistakes or have an obviously plainer form)
// ---------------------------------------------------------------------------------------------

const TASK_NAMES = new Set(['wait', 'spawn', 'delay']);
const MISSING = {
  require: "'require' does not exist in Wick. A script cannot load another one; share values through _G instead.",
  loadstring: "'loadstring' is not available in Wick scripts, which run in a sandbox.",
  load: "'load' is not available in Wick scripts, which run in a sandbox.",
  dofile: "'dofile' is not available in Wick scripts, which run in a sandbox.",
  io: "'io' is not available in Wick scripts, which run in a sandbox (no files).",
  debug: "'debug' is not available in Wick scripts, which run in a sandbox.",
  package: "'package' is not available in Wick scripts.",
  CFrame: 'Wick has no CFrame. Use Vector3 for positions and the Rotation property to turn things.',
  Enum: 'Wick has no Enum. Use plain text instead, for example Material = "Wood".',
  tick: "'tick' does not exist in Wick. Use os.clock() for a timer or os.time() for the date.",
};

function numberValue(tok) { return tok && tok.t === 'num' ? Number(tok.v) : NaN; }

function hints(tokens, text, diagnostics) {
  const T = tokens.filter((t) => t.t !== 'ws' && t.t !== 'cmt');
  const at = (k) => T[k];
  const isOp = (k, v) => at(k) && at(k).t === 'op' && at(k).v === v;
  const afterDot = (k) => k > 0 && at(k - 1).t === 'op' && (at(k - 1).v === '.' || at(k - 1).v === ':');

  for (let k = 0; k < T.length; k++) {
    const t = T[k];
    if (t.t === 'op' && t.luau) {
      const fixes = { '!=': ['~=', "Lua writes 'not equal' as ~="], '&&': ['and', "Lua writes '&&' as 'and'"], '||': ['or', "Lua writes '||' as 'or'"] };
      if (fixes[t.v]) diagnostics.push({ s: t.s, e: t.e, kind: 'fix', msg: fixes[t.v][1], fix: { s: t.s, e: t.e, text: fixes[t.v][0], label: `Use ${fixes[t.v][0]}` } });
    } else if (t.t === 'op' && t.v === '!' && !(isOp(k + 1, '='))) {
      diagnostics.push({ s: t.s, e: t.e, kind: 'fix', msg: "Lua writes '!' as 'not'.", fix: { s: t.s, e: t.e, text: 'not ', label: "Use 'not'" } });
    }
    if (t.t !== 'name' || afterDot(k)) continue;
    const prev = at(k - 1);
    const callLike = isOp(k + 1, '(') || (isOp(k + 1, '.') || isOp(k + 1, ':'));
    if (TASK_NAMES.has(t.v) && isOp(k + 1, '(') && !(prev && prev.t === 'kw' && (prev.v === 'function' || prev.v === 'local'))) {
      diagnostics.push({ s: t.s, e: t.e, kind: 'fix', msg: `'${t.v}' does not exist in Wick. The Wick version is task.${t.v}.`, fix: { s: t.s, e: t.e, text: `task.${t.v}`, label: `Use task.${t.v}` } });
    } else if (MISSING[t.v] && callLike && !(prev && prev.t === 'kw' && (prev.v === 'function' || prev.v === 'local'))) {
      diagnostics.push({ s: t.s, e: t.e, kind: 'error', msg: MISSING[t.v], fix: null });
    } else if (t.v === 'game' && isOp(k + 1, '.') && at(k + 2)?.v === 'Workspace') {
      diagnostics.push({ s: t.s, e: at(k + 2).e, kind: 'tip', msg: "'workspace' is a shorter way to write game.Workspace.", fix: { s: t.s, e: at(k + 2).e, text: 'workspace', label: 'Use workspace' } });
    } else if (t.v === 'game' && isOp(k + 1, ':') && at(k + 2)?.v === 'GetService' && isOp(k + 3, '(') && at(k + 4)?.t === 'str' && /^["']Workspace["']$/.test(at(k + 4).v) && isOp(k + 5, ')')) {
      diagnostics.push({ s: t.s, e: at(k + 5).e, kind: 'tip', msg: "'workspace' is a shorter way to get the Workspace.", fix: { s: t.s, e: at(k + 5).e, text: 'workspace', label: 'Use workspace' } });
    } else if (t.v === 'Vector3' && isOp(k + 1, '.') && at(k + 2)?.v === 'new' && isOp(k + 3, '(') && isOp(k + 5, ',') && isOp(k + 7, ',') && isOp(k + 9, ')')) {
      const v = [at(k + 4), at(k + 6), at(k + 8)].map(numberValue);
      const same = v.every((n) => n === v[0]);
      if (same && (v[0] === 0 || v[0] === 1)) {
        const name = v[0] === 0 ? 'zero' : 'one';
        diagnostics.push({ s: t.s, e: at(k + 9).e, kind: 'tip', msg: `Vector3.${name} is the same value, and shorter.`, fix: { s: t.s, e: at(k + 9).e, text: `Vector3.${name}`, label: `Use Vector3.${name}` } });
      }
    } else if (t.v === 'math' && isOp(k + 1, '.') && at(k + 2)?.v === 'pow' && isOp(k + 3, '(')) {
      // math.pow(a, b) -> (a) ^ (b), only when the call has exactly two top-level arguments
      let depth = 0, comma = -1, close = -1;
      for (let j = k + 3; j < T.length; j++) {
        const x = T[j];
        if (x.t === 'op' && '([{'.includes(x.v)) depth++;
        else if (x.t === 'op' && ')]}'.includes(x.v)) { depth--; if (depth === 0) { close = j; break; } } else if (depth === 1 && x.t === 'op' && x.v === ',') { if (comma >= 0) { comma = -2; break; } comma = j; }
      }
      if (comma > 0 && close > 0) {
        const a = text.slice(T[k + 4].s, T[comma - 1].e), b = text.slice(T[comma + 1].s, T[close - 1].e);
        diagnostics.push({ s: t.s, e: T[close].e, kind: 'fix', msg: "math.pow does not exist in Lua 5.5. Use the ^ operator.", fix: { s: t.s, e: T[close].e, text: `((${a}) ^ (${b}))`, label: 'Use the ^ operator' } });
      } else diagnostics.push({ s: t.s, e: at(k + 2).e, kind: 'error', msg: 'math.pow does not exist in Lua 5.5. Write a ^ b instead.', fix: null });
    }
  }

  // while true do ... end without any waiting: WickGuard would stop the script
  for (let k = 0; k + 2 < T.length; k++) {
    if (!(T[k].t === 'kw' && T[k].v === 'while' && T[k + 1].t === 'kw' && T[k + 1].v === 'true' && T[k + 2].t === 'kw' && T[k + 2].v === 'do')) continue;
    let depth = 1, waits = false;
    for (let j = k + 3; j < T.length && depth > 0; j++) {
      const x = T[j];
      if (x.t === 'kw') {
        if (x.v === 'function' || x.v === 'if' || x.v === 'do' || x.v === 'repeat') depth++;
        else if (x.v === 'end' || x.v === 'until') depth--;
        else if (x.v === 'break' || x.v === 'return' || x.v === 'goto') waits = true;
      } else if (x.t === 'name' && (x.v === 'wait' || x.v === 'Wait' || x.v === 'yield')) waits = true;
    }
    if (!waits) diagnostics.push({ s: T[k].s, e: T[k + 2].e, kind: 'error', msg: 'This loop never waits, so Wick stops the script after a moment to protect the page. Add task.wait() inside the loop.', fix: null });
  }
}

// ---------------------------------------------------------------------------------------------

const cache = { text: null, result: null };

export function analyze(text) {
  if (cache.text === text) return cache.result;
  const diagnostics = [];
  const tokens = tokenize(text, diagnostics);
  const stop = parseTokens(tokens, text, diagnostics);
  if (stop) {
    const t = stop.tok;
    let fix = stop.fix;
    // Only offer a fix that really makes this error go away.
    if (fix) {
      const fixed = text.slice(0, fix.s) + fix.text + text.slice(fix.e);
      const again = parseTokens(tokenize(fixed, []), fixed, []);
      if (again && again.message === stop.message && again.tok.s === t.s) fix = null;
    }
    const atEnd = t.t === 'eof';
    diagnostics.push({ s: atEnd ? Math.max(0, text.length - 1) : t.s, e: atEnd ? text.length : t.e, kind: 'error', msg: stop.message, fix });
    if (fix) diagnostics[diagnostics.length - 1].kind = 'fix';
  }
  hints(tokens, text, diagnostics);
  diagnostics.sort((a, b) => a.s - b.s || a.e - b.e);
  cache.text = text;
  cache.result = { tokens, diagnostics };
  return cache.result;
}

/** Quick syntax verdict for tests: the first real error message, or null. */
export function firstError(text) {
  return analyze(text).diagnostics.find((d) => d.kind !== 'tip' && d.msg.startsWith('Syntax error'))?.msg ?? null;
}
