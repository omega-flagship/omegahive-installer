/**
 * Whether a saved text is an HTML document, the rule the hive's server applies before it serves a text as a view
 * (hive/core/views.py, is_html_document): after an optional byte order mark and whitespace, it opens with an HTML
 * doctype or an <html> tag (WHATWG MIME Sniffing 7.1, the first two HTML patterns). A fragment such as "<b>Note</b>"
 * stays text. Both sides are tested against the same cases (hive/tests/fixtures/html_document_cases.json).
 */
const DOCUMENT_START = /^(?:<!doctype\s+html|<html)(?=[\s>])/i

export const isHtmlDocument = (text: string): boolean => DOCUMENT_START.test(text.replace(/^\uFEFF/, '').replace(/^[\t\n\f\r ]+/, ''))
