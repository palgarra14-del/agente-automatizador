# Commercial feedback loop

`aggregateCommercialFeedback()` converts privacy-safe prospect snapshots into inspectable cohort statistics.

It produces:

- overall explicit stage counts;
- transparent conversion ratios with named denominators;
- groups by source, niche, city, Sales Fit segment, website quality, evidence bucket and score buckets;
- a minimum-sample flag indicating when the data is large enough for human review.

A group below the configured sample threshold remains visible but is marked `sufficientSample: false`. Reaching the threshold only means “ready for review”; it does **not** authorize automatic score or weight changes.

The intended loop is:

LeadFinder evidence → Callflow explicit outcome → privacy-safe snapshot → aggregate → human review/calibration evidence → separately reviewed ranking change.

This keeps real commercial outcomes authoritative without turning a small sample into an opaque self-training model.
