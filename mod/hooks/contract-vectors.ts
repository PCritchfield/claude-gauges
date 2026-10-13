// Shared contract cases: the body below this header is pure JSON, read by tests/run.sh as `tail -n +3 | jq`.
export default
{
  "about": "Shared cases for the gauges mod (mod/hooks/*.test.ts) and statusline.sh (tests/run.sh). Both suites run every case. pace: secondsLeft is resets_at minus now in seconds (null: no reset time); pct is shown rounded, shownProjection floored and only at >= PACE_WARN. sanitize: in -> out after stripping the UNSAFE class. records: one session file's text read back as file <id>.json; expect is null when the row is dropped, else the fields it must carry. A text holding PAD4096 has it replaced by 4096 'x' characters before use.",
  "constants": {
    "WARN_AT": 50,
    "HIGH_AT": 80,
    "PACE_WARN": 100,
    "PACE_HIGH": 125,
    "MIN_ELAPSED": 0.1,
    "ROSTER_VERSION": 1,
    "STALE_SECS": 120,
    "MAX_FILES": 20
  },
  "pace": [
    {
      "name": "on track",
      "kind": "five_hour",
      "pct": 20,
      "secondsLeft": 9000,
      "level": 0,
      "shownProjection": null
    },
    {
      "name": "amber at projected >= 100",
      "kind": "five_hour",
      "pct": 55,
      "secondsLeft": 9000,
      "level": 1,
      "shownProjection": 110
    },
    {
      "name": "projected exactly 100 is amber",
      "kind": "five_hour",
      "pct": 50,
      "secondsLeft": 9000,
      "level": 1,
      "shownProjection": 100
    },
    {
      "name": "red at projected >= 125",
      "kind": "five_hour",
      "pct": 25,
      "secondsLeft": 14400,
      "level": 2,
      "shownProjection": 125
    },
    {
      "name": "no projection before 10% elapsed",
      "kind": "five_hour",
      "pct": 30,
      "secondsLeft": 17100,
      "level": 0,
      "shownProjection": null
    },
    {
      "name": "10% elapsed boundary: float lands just under, so no projection",
      "kind": "five_hour",
      "pct": 15,
      "secondsLeft": 16200,
      "level": 0,
      "shownProjection": null
    },
    {
      "name": "raw backstop at 80 is red",
      "kind": "five_hour",
      "pct": 85,
      "secondsLeft": 900,
      "level": 2,
      "shownProjection": null
    },
    {
      "name": "raw exactly 80 is red",
      "kind": "five_hour",
      "pct": 80,
      "secondsLeft": 1800,
      "level": 2,
      "shownProjection": null
    },
    {
      "name": "backstop applies before 10% elapsed too",
      "kind": "five_hour",
      "pct": 81,
      "secondsLeft": 17100,
      "level": 2,
      "shownProjection": null
    },
    {
      "name": "reset time in the past clamps to a full window",
      "kind": "five_hour",
      "pct": 50,
      "secondsLeft": -60,
      "level": 0,
      "shownProjection": null
    },
    {
      "name": "no reset time falls back to fixed 50/80",
      "kind": "five_hour",
      "pct": 55,
      "secondsLeft": null,
      "level": 1,
      "shownProjection": null
    },
    {
      "name": "seven_day uses its own window",
      "kind": "seven_day",
      "pct": 60,
      "secondsLeft": 302400,
      "level": 1,
      "shownProjection": 120
    },
    {
      "name": "seven_day backstop",
      "kind": "seven_day",
      "pct": 81,
      "secondsLeft": 600000,
      "level": 2,
      "shownProjection": null
    },
    {
      "name": "spend_limit falls back to fixed 50/80, pct rounded",
      "kind": "spend_limit",
      "pct": 62.8,
      "secondsLeft": 999999,
      "level": 1,
      "shownProjection": null
    },
    {
      "name": "spend_limit at 80 is red",
      "kind": "spend_limit",
      "pct": 80,
      "secondsLeft": null,
      "level": 2,
      "shownProjection": null
    }
  ],
  "sanitize": [
    {
      "name": "plain text untouched",
      "in": "groupyBot",
      "out": "groupyBot"
    },
    {
      "name": "C0 controls and ESC",
      "in": "a\u0000b\u001b[31mc\u001fd",
      "out": "ab[31mcd"
    },
    {
      "name": "DEL and C1",
      "in": "a\u007fb\u0080c\u009bd\u009fe",
      "out": "abcde"
    },
    {
      "name": "Arabic letter mark U+061C",
      "in": "a\u061cb",
      "out": "ab"
    },
    {
      "name": "zero-width U+200B-U+200D",
      "in": "a\u200bb\u200cc\u200dd",
      "out": "abcd"
    },
    {
      "name": "LRM, RLM U+200E-U+200F",
      "in": "a\u200eb\u200fc",
      "out": "abc"
    },
    {
      "name": "line and paragraph separators U+2028-U+2029",
      "in": "a\u2028b\u2029c",
      "out": "abc"
    },
    {
      "name": "bidi embeddings and overrides U+202A-U+202E",
      "in": "a\u202ab\u202bc\u202cd\u202de\u202ef",
      "out": "abcdef"
    },
    {
      "name": "word joiner and invisible operators U+2060-U+2064",
      "in": "a\u2060b\u2064c",
      "out": "abc"
    },
    {
      "name": "bidi isolates U+2066-U+2069",
      "in": "a\u2066b\u2067c\u2068d\u2069e",
      "out": "abcde"
    },
    {
      "name": "BOM U+FEFF",
      "in": "a\ufeffb",
      "out": "ab"
    },
    {
      "name": "tag characters U+E0000-U+E007F",
      "in": "a\udb40\udc00b\udb40\udc41c\udb40\udc7fd",
      "out": "abcd"
    },
    {
      "name": "neighbours of the class are kept",
      "in": "\u061b\u200a\u2027\u202f\u205f\u2065\u206a\ufefe\udb40\udc80",
      "out": "\u061b\u200a\u2027\u202f\u205f\u2065\u206a\ufefe\udb40\udc80"
    }
  ],
  "records": [
    {
      "name": "a v1 needs-you row",
      "file": "aaaaaaaa-0000-0000-0000-00000000000a",
      "text": "{\"v\":1,\"id\":\"aaaaaaaa-0000-0000-0000-00000000000a\",\"label\":\"alpha\",\"branch\":null,\"status\":\"needs-you\",\"needs\":\"approve Bash\",\"since\":1791920000000,\"model\":null,\"contextPct\":10,\"costUsd\":0.5,\"task\":null,\"agents\":0,\"startedAt\":0}",
      "expect": {
        "label": "alpha",
        "status": "needs-you",
        "needs": "approve Bash",
        "isMinimal": false
      }
    },
    {
      "name": "id must equal the file name",
      "file": "aaaaaaaa-0000-0000-0000-00000000000b",
      "text": "{\"v\":1,\"id\":\"someone-else\",\"label\":\"bravo\",\"status\":\"needs-you\",\"needs\":\"approve Bash\",\"since\":0}",
      "expect": null
    },
    {
      "name": "v must be a number",
      "file": "aaaaaaaa-0000-0000-0000-00000000000c",
      "text": "{\"v\":\"1\",\"id\":\"aaaaaaaa-0000-0000-0000-00000000000c\",\"label\":\"charlie\",\"status\":\"needs-you\",\"since\":0}",
      "expect": null
    },
    {
      "name": "not an object",
      "file": "aaaaaaaa-0000-0000-0000-00000000000d",
      "text": "[\"delta\"]",
      "expect": null
    },
    {
      "name": "not JSON",
      "file": "aaaaaaaa-0000-0000-0000-00000000000e",
      "text": "{\"v\":1,\"id\":\"aaaaaaaa-0000-0000-0000-00000000000e\",\"label\":\"echo\"",
      "expect": null
    },
    {
      "name": "a newer version shows label and status only",
      "file": "aaaaaaaa-0000-0000-0000-00000000000f",
      "text": "{\"v\":2,\"id\":\"aaaaaaaa-0000-0000-0000-00000000000f\",\"label\":\"foxtrot\",\"status\":\"needs-you\",\"needs\":\"approve Bash\",\"since\":5}",
      "expect": {
        "label": "foxtrot",
        "status": "needs-you",
        "needs": null,
        "since": 0,
        "isMinimal": true
      }
    },
    {
      "name": "unsafe characters stripped from the label",
      "file": "aaaaaaaa-0000-0000-0000-000000000010",
      "text": "{\"v\":1,\"id\":\"aaaaaaaa-0000-0000-0000-000000000010\",\"label\":\"gol\\u202ef\\u001b[2J\",\"status\":\"needs-you\",\"needs\":\"approve Bash\",\"since\":0}",
      "expect": {
        "label": "golf[2J",
        "status": "needs-you"
      }
    },
    {
      "name": "a missing label falls back to the id's first 8",
      "file": "aaaaaaaa-0000-0000-0000-000000000011",
      "text": "{\"v\":1,\"id\":\"aaaaaaaa-0000-0000-0000-000000000011\",\"label\":\"  \",\"status\":\"needs-you\",\"needs\":\"approve Bash\",\"since\":0}",
      "expect": {
        "label": "aaaaaaaa",
        "status": "needs-you"
      }
    },
    {
      "name": "an unknown status is read as unknown",
      "file": "aaaaaaaa-0000-0000-0000-000000000012",
      "text": "{\"v\":1,\"id\":\"aaaaaaaa-0000-0000-0000-000000000012\",\"label\":\"hotel\",\"status\":\"rm -rf\",\"since\":0}",
      "expect": {
        "label": "hotel",
        "status": "unknown",
        "needs": null
      }
    },
    {
      "name": "a file over 4096 bytes is dropped",
      "file": "aaaaaaaa-0000-0000-0000-000000000013",
      "text": "{\"v\":1,\"id\":\"aaaaaaaa-0000-0000-0000-000000000013\",\"label\":\"india\",\"status\":\"needs-you\",\"since\":0,\"pad\":\"PAD4096\"}",
      "expect": null
    }
  ]
}
