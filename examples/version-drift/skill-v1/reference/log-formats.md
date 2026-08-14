# Recognized log formats

The formats below are the ones this skill knows how to read. Anything else is
treated as unstructured text: severity counting still works, timestamp
extraction does not.

## ISO 8601 prefix

```
2026-01-14T09:31:07Z ERROR checkout failed for order 4471
```

Timestamp is the first whitespace-delimited token. Severity is the second.

## Bracketed severity

```
[WARN] 2026-01-14 09:31:07 retry scheduled in 30s
```

Severity is inside the leading brackets; the timestamp follows it as two
tokens (date, then time).

## Syslog-style

```
Jan 14 09:31:07 host app[812]: INFO worker started
```

The year is absent. Report the window using the month and day only, and note
in the report that the year was not present in the file.

## Severity vocabulary

Treat these as equivalent when counting:

| Reported as | Also matches |
|---|---|
| `ERROR` | `ERR`, `FATAL`, `CRIT` |
| `WARN` | `WARNING` |
| `INFO` | `NOTICE` |

Lines with no recognizable severity token are counted separately as
"unclassified" and are never silently dropped from the totals.
