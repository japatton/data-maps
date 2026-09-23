# Synthetic records

Every `.log` file under this directory was written by data-maps. None of it
was captured from a system or copied from anyone's log: each record follows a
vendor's documented structure (a format string, a schema, a source-code
format specifier) with values we invented.

They exist for blocks where no public record in the right wire format could be
found, so that each still has something with the correct shape. They show what
a record *looks like*; they are not evidence of what a real device sends, and a
block that gains a real sample drops its synthetic record (the build refuses
both at once).

`SOURCES.json` records, for each file, the structure it follows
(`structure_from`: what it is, where it is published, and the commit or the
date it was read) and how the record was built (`method`). Structures are
reproduced as layouts - field order, key names, delimiters - not as copied
text.

Invented values use reserved ranges: IPv4 192.0.2.0/24, 198.51.100.0/24 and
203.0.113.0/24 (RFC 5737), the example.com / .net / .org domains (RFC 2606),
host `host01`, users `user01` / `admin01`, signature and plugin identifiers in
the 9000000 range, CVE-2099-xxxx, and 2026-09-23T12:00:00Z. Anything shaped
like a real host, person or organisation is not intended to be one.
