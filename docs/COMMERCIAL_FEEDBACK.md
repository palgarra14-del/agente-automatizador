# Privacy-safe commercial feedback

This module defines the data contract used to measure whether observable LeadFinder signals correlate with commercial outcomes.

## Contract

One row represents one already-discovered prospect. It contains only bounded commercial dimensions and explicit boolean stages:

- source, niche and city;
- Sales Fit segment and website-quality class;
- one allowlisted evidence bucket;
- numeric LeadFinder score dimensions;
- discovered, contacted, interested, demo, proposal, won and lost.

The contract rejects unknown fields. Phone, email, business/person names, notes, observations, message text and other free text are therefore not accepted. It also requires every funnel stage to be explicitly boolean. A later outcome never causes an earlier stage to be inferred.

## Evidence buckets

Allowed values are:

- `no_owned_website`
- `marketplace_owned_gap`
- `weak_mobile`
- `weak_conversion`
- `outdated_live_site`
- `strong_business_web_gap`
- `other_verified_gap`
- `unknown`

These are measurement labels, not claims about revenue, traffic or causality.

## Safety

The aggregate contains no lead identity. It is suitable for measuring cohorts, not reconstructing individual prospects. The implementation never changes ranking weights automatically.
