# What is being predicted

> Will outside money reach 10% of the migration threshold within two hours of launch?

Everything in this repository is scored against that one sentence. It is narrow on
purpose: a narrow claim can be checked, and a checkable claim is the only kind worth
publishing.

## Why not price

Price cannot be scored honestly on a two-hour horizon without first picking an exit
rule, and any exit rule is a trading strategy wearing the costume of a measurement.
Change the rule and the same model becomes brilliant or worthless. Money arriving is
observable, unambiguous, and settles on its own.

**A high score is not advice to buy.** A token can attract outside demand and still
lose value.

## What counts as outside money

A buy counts only if it is none of the following:

| Excluded | Why |
|---|---|
| part of the launch transaction | the opening buy by the creator is not demand |
| sent by the deployer | an operator funding their own curve is not demand |
| sent by a wallet declared tax-exempt | the deployer names these at launch, so they are insiders by their own declaration |

Without these exclusions, a creator who buys 20% of their own supply would appear as
a runaway success. An early version of this project measured exactly that, and the
resulting numbers were meaningless.

## The window is fixed, not open-ended

Each launch is observed for exactly two hours from its own launch block, and the
outcome is recorded once. This matters more than it looks:

- **A fixed window is comparable.** A launch observed for two hours and one observed
  for six are not the same measurement. Mixing them makes the base rate a function of
  when the data happened to be collected.
- **Right-censoring is handled by construction.** A launch still inside its window has
  no outcome yet, so it is not counted at all. It is never recorded as a failure.
- **Late resolution does not corrupt it.** The resolver reads the block range from
  launch to launch plus two hours. If the queue is behind and the check happens four
  hours later, the window measured is still the original two hours.

## Threshold

The event fires when qualifying buys reach **10%** of the amount needed to fill the
bonding curve. The logs store the raw values, not only the boolean, so the threshold
can be moved afterwards and the entire record rescored.

## Known measurement error

Outcomes are read from public RPC endpoints under rate limits. When a range of logs
cannot be read after retries, the outcome is recorded with `complete: false`. Those
reads undercount buys, and therefore undercount the event. The flag is stored so the
error can be measured rather than assumed away.

See [model.md](model.md) for how these labels become a probability.
