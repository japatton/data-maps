// One dataset format, for a reader who is not going to open Studio: a
// spreadsheet, a diff, or a paste into a ticket.
//
// Pure string functions - nothing here touches the DOM, so the Node tests
// exercise exactly what the browser runs, as with review-files.js.

import { emit } from "./yaml-emit.js";

// The three identifying columns lead every row on purpose: a CSV that has
// been mailed on has to say what it is a mapping of, and a spreadsheet has
// nowhere else to put that.
export const CSV_COLUMNS = [
  "technology", "dataset", "format", "#",
  "vendor", "type", "description", "ecs", "status",
  "custom", "transform", "notes",
];

// The field keys behind the columns after the row number, in the order the
// editor shows them.
const FIELD_KEYS = ["vendor", "type", "description", "ecs", "status",
                    "custom", "transform", "notes"];

export function toCsv(doc) {
  const lines = [CSV_COLUMNS.map(csvCell).join(",")];
  fieldsOf(doc).forEach((field, at) => {
    const row = [techId(doc), datasetId(doc), formatId(doc), String(at + 1)];
    for (const key of FIELD_KEYS) row.push(text(field[key]));
    lines.push(row.map(csvCell).join(","));
  });
  // CRLF between records: RFC 4180 says so, and these are opened in Excel.
  // A newline *inside* a cell stays the newline the author typed.
  return lines.join("\r\n") + "\r\n";
}

export function toJson(doc) {
  return JSON.stringify(record(doc), null, 2) + "\n";
}

// Through the shared emitter rather than a second dialect: a description of
// "yes" has to come back a string, and that rule already lives in one place.
export function toYaml(doc) {
  return emit(record(doc));
}

export function exportName(doc, ext) {
  return [techId(doc), datasetId(doc), formatId(doc)].join("-") + "." + ext;
}

// The context, then the fields with their empty keys dropped - an absent
// `custom` is not the same as an empty one, and writing it out would put a
// column of blanks into every document.
function record(doc) {
  return {
    technology: techId(doc),
    dataset: datasetId(doc),
    format: formatId(doc),
    fields: fieldsOf(doc).map((field) => {
      const out = {};
      for (const key of FIELD_KEYS) {
        const value = text(field ? field[key] : "");
        if (value !== "") out[key] = value;
      }
      return out;
    }),
  };
}

// Quoted only when it has to be, so the common cell stays readable in a
// diff.  split/join rather than replaceAll, which is newer than the floor.
function csvCell(value) {
  const cell = text(value);
  if (/[",\r\n]/.test(cell)) return '"' + cell.split('"').join('""') + '"';
  return cell;
}

function fieldsOf(doc) {
  const format = (doc && doc.format) || {};
  return Array.isArray(format.fields) ? format.fields : [];
}

function techId(doc) {
  return text(doc ? doc.techId : "");
}

function datasetId(doc) {
  const dataset = (doc && doc.dataset) || {};
  return text(dataset.id);
}

// doc.format is the format object; its own `format` key is the id it goes by.
function formatId(doc) {
  const format = (doc && doc.format) || {};
  return text(format.format);
}

function text(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}
