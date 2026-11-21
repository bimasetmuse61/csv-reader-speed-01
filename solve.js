// A fast drop-in for csv-reader 1.0.0 (make.fun's own reference program): run(input) returns
// exactly csv-reader's answer {columns, rows, errors} for every input {text, header}.
//
// Same reading, left to right, as the reference (vendor/csv-reader/index.js in the kit):
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (error stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled, "" inside it
//     one quote and each CRLF or lone CR inside it read as LF; what follows its closing quote,
//     up to the next comma or line break, is appended as it stands (quote_junk, when the field
//     ends); a quote that never closes is a literal character, and the text after it is read
//     again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings;
//   - columns is the first record when header is true, else null; rows holds the records after
//     it, each padded with "" (short_row, with fields: its count) or cut (long_row, with extra:
//     the cut fields) to the first record's width;
//   - each error is {code, line, row}, in the order met; line is the 1-based line its record
//     starts on, row its record's index in rows (null for the header).
//
// Speed comes from never walking the text one character at a time: a record whose first line
// holds no quote and no stray CR is split in one native call; every other field is found with
// one indexOf and taken as one slice, and only a quoted field's closing quote (and the rare
// line break inside it, or stray CR) is handled piece by piece. The field readers report
// through shared slots, so no object is allocated per field. No state is kept from one case
// to the next: run() is pure.

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;
  // The next LF at or after the record's start (-1: none left); an unquoted field ends at a
  // comma before it, at it, or at the end of the text. Refreshed when a quoted field carries
  // pos past it.
  let curNl = -1;

  // The field just read: its value, how it ended (0 comma, 1 line break, 2 end of text) and
  // how many characters were kept onto it.
  let fValue = '';
  let fEnded = 0;
  let fAdded = 0;

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR not
  // followed by LF is dropped (stray_cr).
  function readUnquoted(value) {
    const before = value.length;
    if (curNl !== -1 && pos > curNl) curNl = text.indexOf('\n', pos);
    const iComma = text.indexOf(',', pos);
    let end;
    let ended;
    if (iComma !== -1 && (curNl === -1 || iComma < curNl)) {
      end = iComma;
      ended = 0;
    } else if (curNl !== -1) {
      end = curNl;
      ended = 1;
    } else {
      end = len;
      ended = 2;
    }
    // A CR just before the line break is the CRLF's own CR, not a stray one.
    const chunkEnd = ended === 1 && end > pos && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
    const chunk = text.slice(pos, chunkEnd);
    const cr = chunk.indexOf('\r');
    if (cr === -1) {
      value += chunk;
    } else {
      // Rare: one or more stray CRs inside this field; drop each, keep the rest.
      let start = 0;
      let idx = cr;
      for (;;) {
        value += chunk.slice(start, idx);
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        start = idx + 1;
        idx = chunk.indexOf('\r', start);
        if (idx === -1) break;
      }
      value += chunk.slice(start);
    }
    pos = ended === 2 ? len : end + 1;
    if (ended === 1) line += 1;
    fValue = value;
    fEnded = ended;
    fAdded = value.length - before;
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    let start = pos;
    for (;;) {
      const q = text.indexOf('"', start);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after it is read
        // again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquoted('"');
        return;
      }
      const chunk = text.slice(start, q);
      if (chunk.indexOf('\n') === -1 && chunk.indexOf('\r') === -1) {
        value += chunk;
      } else {
        // Rare: line breaks inside the quotes; each CRLF or lone CR is one LF.
        let s = 0;
        let conv = '';
        for (let i = 0; i < chunk.length; i++) {
          const ch = chunk.charCodeAt(i);
          if (ch === 13 || ch === 10) {
            conv += chunk.slice(s, i) + '\n';
            line += 1;
            if (ch === 13 && chunk.charCodeAt(i + 1) === 10) i += 1;
            s = i + 1;
          }
        }
        value += conv + chunk.slice(s);
      }
      if (text.charCodeAt(q + 1) === 34) {
        value += '"';
        start = q + 2;
        continue;
      }
      pos = q + 1;
      if (pos >= len) {
        fValue = value;
        fEnded = 2;
        fAdded = 0;
        return;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fValue = value;
        fEnded = 0;
        fAdded = 0;
        return;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        fValue = value;
        fEnded = 1;
        fAdded = 0;
        return;
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fValue = value;
        fEnded = 1;
        fAdded = 0;
        return;
      }
      // What follows the closing quote is appended as it stands, up to the next comma or
      // line break.
      readUnquoted(value);
      if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: the record ends at this line's break and the line holds no quote and no
    // stray CR, so its fields are the line split at the commas.
    const nl = text.indexOf('\n', pos);
    curNl = nl;
    const lineEnd = nl === -1 ? len : nl;
    const firstLine = text.slice(pos, lineEnd);
    if (firstLine.indexOf('"') === -1) {
      const cr = firstLine.indexOf('\r');
      if (cr === -1 || (nl !== -1 && cr === firstLine.length - 1)) {
        const fields = (cr === -1 ? firstLine : firstLine.slice(0, -1)).split(',');
        pos = nl === -1 ? len : nl + 1;
        if (nl !== -1) line += 1;
        // A line left with no characters is no record.
        if (fields.length === 1 && fields[0] === '') continue;
        if (width < 0) width = fields.length;
        if (header && columns === null) {
          columns = fields;
          continue;
        }
        if (fields.length < width) {
          errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
          while (fields.length < width) fields.push('');
        } else if (fields.length > width) {
          errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
        }
        rows.push(fields);
        continue;
      }
    }

    // Slow path: the record holds a quote or a stray CR (or spans lines); read it a field
    // at a time, exactly as the reference does.
    const fields = [];
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fValue);
    } while (fEnded === 0);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr
    // errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
