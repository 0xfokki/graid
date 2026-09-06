# Model card

## Summary

Naive Bayes on log-odds with shrinkage, followed by Platt calibration. Seven
features, all readable at the moment a launch appears on chain. No language model is
involved anywhere.

The model is deliberately simple. What makes this project worth anything is the
discipline around the prediction — written before the outcome exists, scored in
public, misses included — not the sophistication of the estimator. A more elaborate
model would make the record harder to check without making it more honest.

## Features

All seven are known at launch time. Nothing measured during the observation window is
allowed in, because that is the window the outcome itself is measured in.

| Signal | What it captures |
|---|---|
| Creator buy | share of supply the creator bought in the launch transaction |
| Deployer history | how many tokens this deployer launched in the rolling hour |
| Tax-exempt wallets | how many wallets were granted opening-tax exemptions |
| Social presence | whether the token published social links |
| Creator fee | the configured creator tax |
| Fee destination | whether fees route to the deployer or to a third party |
| Pair type | whether the curve is paired with ETH or a stock token |

### One feature was removed for leaking

"Creator dumped" is a strong signal, and it is **not** in the model. The sell happens
inside the same two-hour window the outcome is measured in, so at launch time it
cannot be known. Including it would have inflated every number in this repository. It
survives only as a display flag on tokens old enough for it to be a fact rather than
a prediction.

## Fitting

Each feature is bucketed. For every bucket the empirical event rate is smoothed
towards the base rate (`ALPHA = 20`), so a bucket holding four observations cannot
dominate, then converted into a log-odds weight relative to that base rate. Weights
are summed and passed through a sigmoid.

**Missing data carries a weight of exactly zero.** A feature that could not be read
must not push the answer in either direction. A test enforces this.

## Reproducing the fit

The four sampled windows the model was fitted on are committed as `src/w*.json`,
so the fit can be reproduced from a clean checkout:

```bash
npm install
npm run model
```

This reproduces every fitted weight exactly. It does **not** reproduce the
`calibration` block, and the version hash will therefore differ. Calibration is a
separate step: the Platt coefficients are fitted against live resolved outcomes,
which arrive after the model is built and are not part of the training windows.
A rebuilt `model.json` is the uncalibrated model.

## Calibration

Raw naive Bayes is overconfident: it treats correlated features as independent and
counts the same evidence more than once. Left alone it claimed 87% where outcomes
occurred 51% of the time.

A Platt transform is fitted on live resolved outcomes and applied to the raw score.
Isotonic regression was tried and rejected on a temporal holdout.

## Validation

Fitted on 600 launches drawn from four separated time windows. Train on three, test
on the fourth, four times over:

```
AUC   0.729   (folds: 0.665 to 0.786)
Brier 0.208   against 0.226 for always guessing the base rate
```

Live results, measured only on predictions recorded before their outcome existed, can
be recomputed with `npm run verify`.

## Known failure modes

- **Overconfident at the top of the scale.** Scores above 80% should be read as
  "stronger than most launches", not as a literal probability. This is published in
  the calibration table rather than hidden.
- **Correlated features are double-counted.** Inherent to naive Bayes. Calibration
  compensates for the average case, not for every case.
- **One market regime.** The training windows all come from a single day.
- **The migration model is thin.** It rests on 12 positive examples. Treat it as
  supporting evidence, never as a forecast.
- **Serial-deployer and bundle effects are unproven.** Both raise the odds in the
  data, but outside money is defined as "not the deployer and not a declared exempt
  wallet". An operator buying through undeclared wallets would be counted as outside
  money. Settling this needs a wallet funding graph, which does not exist yet.
