# Week 7: three designs, three kills, and a sentence that was wrong in a band (2026-07-30 → 2026-07-31)

The week produced no behaviour change, which is the entry. Issue #59 went
into a design round with three candidate fixes and came out with none, and
the most useful thing found was not in any of them: a sentence already
shipped in the security model that is true for most inputs and false for a
narrow, reachable range.

## 2026-07-31: the design round that killed everything it built

Issue #59 says that no secret rule matches a filesystem path, so ordinary
tool output puts the operator's home directory into a durable row that
`telemetry export` emits. The issue listed four options and named the second,
normalising `$HOME` to `~` on the way into retained sinks, as strongest on a
first pass. Uncosted, unpanelled.

That is the same position issue #53 was in two days earlier, when the
preferred fix was a keyed HMAC and a three-reviewer panel killed it. So this
one got the same treatment before any code: map every retained sink, build
three designs from different angles, and give each design its own hostile
reviewer briefed to refute rather than improve.

All three were killed, and the interesting part is that they died of three
different causes rather than one.

The narrow design, eliding the home directory inside `truncate`, rested its
scope argument on a claim about which rows carry a digest. Execution refuted
it.

The sink-complete design carried an injectivity proof, and the proof was
false. It reasoned only about position 0, on the grounds that a real absolute
path cannot begin with `~`. But the replacement was global and a literal `~`
is a legal directory name at any depth:

```
/Users/<name>/clone/a/Users/<name>/pad/evil.md
/Users/<name>/clone/a~/pad/evil.md
```

Two distinct paths, distinct digests today, and one identical digest under
the design. The field's entire purpose is telling those two apart, which is
what issue #50 was about. A change sold as closing a disclosure would have
silently broken a correlation guarantee, and nothing in the row would show it.

The export-time design claimed to fail closed. It rejects a malformed `$HOME`
and it does so correctly, but a malformed `$HOME` is not the failure that
matters. `os.homedir()` returns `$HOME` verbatim, so a well-formed but wrong
one, CI's `/home/runner`, a container's `/root`, or a database exported from
another machine via `--db`, makes the transform a total no-op that still
prints its reassuring message and still exits 0. It converts a
known-unscrubbed artefact into a believed-scrubbed one.

The shared cause is worth more than any of the three designs: every one of
them keyed the transform on a value that is not recorded in the row, is
legitimately variable, and degrades with no signal. That is structurally the
same defect the #53 panel rejected the HMAC for. The rule that came out of
it, now binding on any future attempt, is that a transform which cannot
report whether it fired is not a mitigation.

## 2026-07-31: the sentence that was wrong in a band

R-16 justifies its severity by saying truncation of a skill-drop path is tail
preserving, so what it discards is the leading directories, exactly where
`/Users/<name>` sits. Reasonable, and it is what the code does. It is also
false for a range of inputs.

Truncation keeps the last `cap` characters, so it drops exactly
`length - cap` leading ones. Just past the cap that drop is one character, or
two, or seven. The username survives until the drop reaches it, which gives a
band where a row carries both a digest and a cleartext username at the same
time.

The band is `[cap + 1, cap + lead.length]`, and its width is the length of
whatever precedes the username rather than anything about the username
itself. Measured, matching that arithmetic exactly: 7 for `/Users/`, 6 for
`/home/`, 15 for a longer service-account path.

The wider point only became visible once the narrow one was measured.
Truncation removes the least identifying part first. Past the band a partial
username survives, and the client or project directory outlives the username
by the username's own length plus the directory sitting between them, a
margin that is measured rather than being a function of the home path's
width. At the first truncating length the stored value literally begins
`…Users/<name>/clients/acme/`. If the worry is disclosure, the client name is
usually the more sensitive of the two, and it is the one that survives
longest.

This strengthens R-16's conclusion while making its stated reason wrong,
which is an awkward combination to write up honestly. The reason is what a
future reader acts on, so both halves are recorded.

## What this week says about the process

The design round was run by a fan-out of agents, and the synthesis it
produced got the band's boundary wrong: it derived the flip from the
username's last character index rather than its first. Under its own fixture,
a seven-character username, that put the band end six characters late.

The mechanism is worth more than the magnitude. Deriving from the last index
makes the band width depend on the username's length, which is precisely the
dependency the real band does not have. Spot-checking it took one script.

That is the second time in three weeks that the load-bearing error was in
prose summarising verified work rather than in the work. The tests were green
throughout. They are still green now, because nothing shipped that a test
could have caught.

The two tests that did land are characterisation tests, green on write, with
no red-first moment. Recording that plainly matters more than dressing it as
a TDD cycle: the substitute is a mutation gate, and the mutation that earns
its place is the one swapping tail-preserving truncation for head-preserving,
because it reddens both new tests and therefore proves they discriminate on
the exact property R-16 rests on.
