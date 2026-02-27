# DataPurge Broker Registry Audit Report

**Date:** 2026-02-26
**Auditor:** Automated audit via Claude
**Registry path:** `/home/user/datapurge/datapurge/brokers/`
**Total brokers:** 179 YAML files across 16 categories

---

## Registry Summary

| Category | Count |
|---|---|
| people-search | 54 |
| data-aggregators | 35 |
| social-scraper | 19 |
| marketing-list | 10 |
| background-check | 8 |
| tenant-screening | 7 |
| financial | 6 |
| location-tracking | 6 |
| other | 6 |
| health | 5 |
| real-estate | 5 |
| employment | 4 |
| insurance | 4 |
| political | 4 |
| public-records | 3 |
| vehicle | 3 |

---

## 1. CRITICAL Issues

These issues would cause errors in application logic or deliver incorrect information to users.

### CRITICAL-01: Category mismatch -- `data-aggregators` directory vs `data-aggregator` field

**All 35 files** in `brokers/data-aggregators/` have `category: data-aggregator` (singular), but the directory name is `data-aggregators` (plural). Any code that validates `category == directory_name` will fail for every file in this category.

**Affected files:** All 35 YAML files in `brokers/data-aggregators/`

**Fix:** Either rename the directory to `data-aggregator` (singular) or update all 35 files to use `category: data-aggregators` (plural). The latter is recommended since the directory name is the canonical reference.

### CRITICAL-02: MediaMath is defunct -- filed for bankruptcy June 2023

`brokers/data-aggregators/mediamath.yaml` lists MediaMath as an active data broker with opt-out URLs at `mediamath.com`. However, MediaMath filed for Chapter 11 bankruptcy on June 30, 2023, shut down all operations, and was subsequently acquired by Infillion in August 2023 for $22 million. The domain, opt-out portal, and privacy email (`privacy@mediamath.com`) are almost certainly non-functional.

**Fix:** Either remove `mediamath.yaml` entirely, or update it to reflect the Infillion acquisition with correct opt-out information, and mark it with a prominent warning that the original company no longer exists.

### CRITICAL-03: Oracle Data Cloud advertising business shut down September 2024

`brokers/data-aggregators/oracle-data-cloud.yaml` notes that Oracle shut down advertising services in September 2024 but claims the opt-out portal remains. The entire Oracle Advertising division (BlueKai, Datalogix, Moat, Grapeshot) was decommissioned. The opt-out URL `datacloudoptout.oracle.com/optout` may no longer function. The email `secalert_us@oracle.com` is a security alert address, not a privacy/opt-out address.

**Fix:** Verify whether `datacloudoptout.oracle.com` is still operational. If not, remove or archive this entry. The email address should be updated to an actual Oracle privacy contact if retained.

### CRITICAL-04: Duplicate broker entries -- Verisk and Infutor are the same company

Two separate entries exist for what is now the same entity:
- `brokers/data-aggregators/verisk.yaml` (domain: verisk.com, aliases include infutor.com)
- `brokers/data-aggregators/infutor.yaml` (domain: infutor.com, aliases include marketing.verisk.com)

Both point to the same opt-out form (`privacy.infutor.com/s/optout-form`) and share the email `privacy@verisk.com`. Verisk acquired Infutor in February 2022 and rebranded it to Verisk Marketing Solutions. Having two entries will cause users to submit duplicate opt-out requests.

**Fix:** Merge into a single entry. Recommend keeping `verisk.yaml` as the primary with `infutor.com` listed as an alias and former name noted.

### CRITICAL-05: Gravy Analytics -- missing Venntel alias and FTC enforcement order

`brokers/location-tracking/gravy-analytics.yaml` does not mention Venntel, which is a subsidiary of Gravy Analytics. In January 2025, the FTC finalized an order **prohibiting** Gravy Analytics and Venntel from selling sensitive location data. The file also does not mention Unacast (the parent company) in the aliases. Additionally, Gravy Analytics suffered a massive data breach in January 2025 exposing 17TB of location data.

**Fix:** Add `venntel.com` and `unacast.com` to aliases. Add FTC enforcement order details to notes and legal section. Update confidence score given regulatory action.

---

## 2. WARNING Issues

These are potential duplicates, stale data, or factual errors that could mislead users.

### WARNING-01: Acxiom aliases list `liveramp.com` but LiveRamp is a separate broker entry

`brokers/data-aggregators/acxiom.yaml` lists `liveramp.com` as an alias, but LiveRamp has its own entry at `brokers/data-aggregators/liveramp.yaml` with a separate domain and distinct opt-out process. Acxiom sold its marketing services division to IPG in 2018 and the data connectivity platform became LiveRamp (a separate public company). They are no longer the same entity.

**Fix:** Remove `liveramp.com` from Acxiom's aliases. Update Acxiom's name to reflect current branding (IPG acquired the marketing services; Acxiom's data connectivity became LiveRamp separately).

### WARNING-02: TransUnion entry aliases overlap with Neustar entry

`brokers/data-aggregators/transunion.yaml` lists `home.neustar` and `neustar.biz` as aliases, but Neustar has its own separate entry at `brokers/data-aggregators/neustar.yaml` with domain `home.neustar`. This creates confusion: both entries claim the same domain.

**Fix:** Either merge the entries (if they share opt-out infrastructure) or clearly delineate them. The current setup appears intentional (TransUnion credit bureau vs. Neustar marketing), but the alias overlap must be resolved -- remove `home.neustar` and `neustar.biz` from TransUnion's aliases since Neustar has its own entry.

### WARNING-03: LexisNexis A-PLUS and CLUE have overlapping aliases

- `brokers/insurance/lexisnexis-aplus.yaml` has alias `consumer.risk.lexisnexis.com`
- `brokers/insurance/lexisnexis-clue.yaml` has domain `consumer.risk.lexisnexis.com`
- `brokers/insurance/lexisnexis-clue.yaml` has alias `personalreports.lexisnexis.com`
- `brokers/insurance/lexisnexis-aplus.yaml` has domain `personalreports.lexisnexis.com`

Each entry's alias is the other's domain. This is a direct domain/alias conflict.

**Fix:** Remove the cross-referencing aliases. Each entry should only have aliases that are genuinely alternative domains for that specific product, not the domain of another broker entry in the registry.

### WARNING-04: Lotame merged into Epsilon -- Lotame entry has `epsilon.com` as alias

`brokers/data-aggregators/lotame.yaml` lists `epsilon.com` as an alias, but Epsilon has its own entry at `brokers/data-aggregators/epsilon.yaml` with `epsilon.com` as its domain. Publicis Groupe acquired Lotame and integrated it into Epsilon effective Q2 2025. Having `epsilon.com` as a Lotame alias conflicts with the Epsilon entry.

**Fix:** Remove `epsilon.com` from Lotame's aliases. Note the Epsilon/Publicis ownership in Lotame's notes but do not claim the domain. Consider whether Lotame should be archived if opt-outs now go through Epsilon.

### WARNING-05: TruthFinder categorized as `background-check` but is primarily a people-search site

`brokers/background-check/truthfinder.yaml` is categorized as `background-check`, but TruthFinder is universally recognized as a people-search site (the Big Ass Data Broker Opt-Out List, State of Surveillance, Optery, and security.org all classify it as people-search). It is part of the PeopleConnect network alongside Intelius, Instant Checkmate, and ZabaSearch (all in `people-search/`). TruthFinder explicitly states it is "not a consumer reporting agency" under the FCRA.

**Fix:** Move `truthfinder.yaml` to `brokers/people-search/` and change `category:` to `people-search`.

### WARNING-06: PeopleConnect subsidiaries have separate entries but share a single suppression

The following 8 brokers all use the PeopleConnect Suppression Center (`suppression.peopleconnect.us/login`) for opt-out:
- Intelius, Instant Checkmate, TruthFinder, US Search, ZabaSearch, AnyWho, Addresses.com

And they all use `privacy@intelius.com` as the email fallback (5 of them explicitly). While having separate entries is useful for scanning different sites, the registry should clearly indicate the shared suppression relationship so users don't submit 8 redundant opt-outs.

**Fix:** Add a field like `suppression_group: peopleconnect` to each PeopleConnect subsidiary so the application can batch these into a single opt-out action.

### WARNING-07: BeenVerified and PeopleLooker are related but not linked

`brokers/people-search/peoplelooker.yaml` notes it is "owned by BeenVerified" and the verification email comes from BeenVerified. However, neither entry references the other. The application could batch these opt-outs.

**Fix:** Add cross-references or a `suppression_group: beenverified` field.

### WARNING-08: Clearbit acquired by HubSpot -- opt-out URL may change

`brokers/social-scraper/clearbit.yaml` correctly notes the HubSpot acquisition but the opt-out URL `dashboard.clearbit.com/ccpa-opt-out` may migrate to HubSpot infrastructure. The domain and privacy email may change as integration progresses.

**Fix:** Monitor for URL changes. Consider adding `hubspot.com` as an alias or note.

### WARNING-09: Verisk ISO aliases overlap with Verisk entry

`brokers/insurance/verisk-iso.yaml` has alias `verisk.com/insurance`, and `brokers/data-aggregators/verisk.yaml` has domain `verisk.com`. While these are different divisions, the alias pattern `verisk.com/insurance` is a URL path, not a separate domain, creating a non-standard alias format.

**Fix:** Remove `verisk.com/insurance` from aliases (it is not a domain). Instead, note the relationship in the `notes` field.

### WARNING-10: Whitepages aliases list includes its own domain

`brokers/people-search/whitepages.yaml` has `aliases: [whitepages.com, premium.whitepages.com]` but `whitepages.com` is already its `domain:` field. This is redundant.

**Fix:** Remove `whitepages.com` from the aliases list, keeping only `premium.whitepages.com`.

### WARNING-11: Experian RentBureau domain is a URL path, not a domain

`brokers/tenant-screening/experian-rentbureau.yaml` has `domain: experian.com/rental-property-solutions/rentbureau`. This is a URL path, not a domain name. The domain field should contain only the domain.

**Fix:** Change domain to `experian.com` and move the full path to a `product_url` field or note. Same issue with alias `experian.com/rentbureau`.

### WARNING-12: Gravy Analytics FTC ban -- may no longer sell data

The FTC finalized an order in January 2025 prohibiting Gravy Analytics from selling sensitive location data. The broker's opt-out process may be moot if they are legally barred from selling the data. The file should reflect this significant regulatory development.

**Fix:** Update legal section and notes to reflect the FTC consent order. Add a field indicating regulatory restrictions.

---

## 3. INFO Issues

Minor improvements, missing optional fields, or style inconsistencies.

### INFO-01: Several aliases are URL paths, not domains

The following entries use URL paths or subdomains as aliases that could be better represented:
- `experian-rentbureau.yaml`: alias `experian.com/rentbureau` (path)
- `verisk-iso.yaml`: alias `verisk.com/insurance` (path)
- `autocheck.yaml`: alias `experian.com/automotive/autocheck-business` (path)
- `transunion-smartmove.yaml`: alias `transunion.com/product/smartmove` (path)

**Recommendation:** Standardize aliases to be domains or subdomains only. Move URL paths to a separate field.

### INFO-02: Some files have empty or near-empty aliases

- `411-info.yaml`: `aliases:` (empty, no brackets)
- `usphonebook.yaml`: `aliases:` (empty, no brackets)
- `searchpeoplefree.yaml`: `aliases:` (empty, no brackets)

Most files with no aliases use `aliases: []`. These three use a bare `aliases:` with no value.

**Recommendation:** Standardize to `aliases: []` for consistency.

### INFO-03: Missing `gdpr` field in some broker legal sections

`brokers/people-search/radaris.yaml` is missing the `gdpr:` field under `legal:`. Other brokers consistently include it.

**Recommendation:** Add `gdpr: false` to Radaris and any other entries missing this field.

### INFO-04: Inconsistent `meta.notes` presence

Some entries like `beenverified.yaml` have no `meta.notes` field at all, while most others have detailed provenance notes. This is inconsistent.

**Recommendation:** Add at minimum a source citation to all entries.

### INFO-05: Acxiom name outdated

`brokers/data-aggregators/acxiom.yaml` says `name: Acxiom (now Kinesso)`. Acxiom's marketing services were rebranded to Kinesso by IPG, but the data/opt-out entity still operates as Acxiom (acxiom.com). The "now Kinesso" label is misleading since the opt-out portal and consumer data operations remain on acxiom.com.

**Recommendation:** Change name to `Acxiom` and note the Kinesso/IPG relationship in notes only.

### INFO-06: Lotame `name` field says "now part of Epsilon"

The name field `Lotame (now part of Epsilon)` embeds acquisition info. This is better suited for the notes field.

**Recommendation:** Use `name: Lotame` and move the Epsilon relationship to notes.

---

## 4. MISSING Major Brokers

The following significant data brokers are absent from the registry.

### MISSING-01: Mobilewalla (location-tracking)
Major location data broker. FTC finalized enforcement order in January 2025 banning it from selling sensitive location data. Collected 500M+ unique advertising IDs with precise location data. Should be in `location-tracking/`.

### MISSING-02: Venntel (location-tracking)
Subsidiary of Gravy Analytics/Unacast. Sells geolocation data to government agencies and law enforcement. Subject to FTC consent order (January 2025). Could be either a separate entry or an alias of Gravy Analytics.

### MISSING-03: Precisely (formerly Syncsort / Pitney Bowes Data)
Major data quality and enrichment company. Acquired Pitney Bowes data business for $700M in 2019. Serves 12,000 companies including 95 of the Fortune 100. Provides location intelligence and consumer data enrichment.

### MISSING-04: Verisk Financial Services / Jornaya
Verisk acquired Jornaya (consumer journey analytics) in 2020. Tracks consumer insurance shopping behavior and sells lead intelligence data. Has its own opt-out process separate from the Infutor/Verisk Marketing entry.

### MISSING-05: Weiss Ratings / Weiss Analytics
Financial data analytics and consumer ratings company.

### MISSING-06: Near Intelligence (location-tracking)
Major location data company (formerly Near). Filed for bankruptcy in 2023 but its data may still be circulating. Was one of the world's largest sources of people-movement data.

### MISSING-07: Babel Street / Locate X
Provides location data analytics to government agencies. Known for Locate X product that tracks phone locations without warrants. Registered California data broker.

### MISSING-08: Palantir (government contractor)
While primarily a government contractor, Palantir processes significant amounts of consumer data and is a registered California data broker.

### MISSING-09: Whitepages Premium / Ekata (TransUnion)
Ekata, now part of TransUnion, provides identity verification using phone, email, address, and IP data. Separate from the Whitepages people-search entry. Registered California data broker.

### MISSING-10: Experian Consumer Direct
The main Experian credit bureau consumer data entry is missing. Currently only `experian-marketing.yaml` and `experian-rentbureau.yaml` exist. The core Experian credit reporting and consumer data operations (credit reports, credit scores, consumer opt-out for prescreened offers) should have their own entry.

### MISSING-11: DMAchoice / Direct Marketing Association
ANA's DMAchoice program allows consumers to opt out of direct mail from member companies. While not a single broker, it is a major opt-out mechanism covering hundreds of companies.

### MISSING-12: Classmates.com
Part of PeopleConnect network. Contains historical yearbook photos and personal information. Has its own opt-out process.

### MISSING-13: FaceCheck.id
Facial recognition people search engine. Growing in popularity and listed on the Big Ass Data Broker Opt-Out List.

### MISSING-14: Ofsearch
People search site recently added to the Big Ass Data Broker Opt-Out List (June 2025 update).

### MISSING-15: California DELETE Act DROP Portal
California's DELETE Request Opt-Out Portal (DROP) launched January 1, 2026. Allows California residents to submit a single deletion request to ALL registered data brokers. This should be documented in the registry or in a companion guide.

---

## 5. Duplicate and Overlap Analysis

### 5.1 Corporate Ownership Groups

The registry should document these corporate relationships to enable batched opt-outs:

**PeopleConnect Group** (8+ entries, single suppression center):
- Intelius, Instant Checkmate, TruthFinder, US Search, ZabaSearch, AnyWho, Addresses.com, Classmates (missing)
- All use `suppression.peopleconnect.us/login`
- All fallback to `privacy@intelius.com`

**BeenVerified Group** (2+ entries):
- BeenVerified, PeopleLooker
- Shared verification email infrastructure

**Experian Group** (3 entries):
- Experian Marketing Services, Experian RentBureau, AutoCheck
- All use `optout@experian.com`

**LexisNexis / RELX Group** (3 entries):
- LexisNexis (data aggregator), LexisNexis C.L.U.E. (insurance), LexisNexis A-PLUS (insurance)
- All use `privacy.information.mgr@lexisnexis.com`
- These are legitimately separate products but should note shared corporate opt-out

**Verisk Group** (3 entries, should be 2):
- Verisk, Infutor (duplicate -- should merge), Verisk ISO
- Infutor shares `privacy@verisk.com`

**TransUnion Group** (3 entries):
- TransUnion, Neustar, TransUnion SmartMove
- Alias overlaps need resolution

### 5.2 Shared Email Addresses

| Email | Used by |
|---|---|
| `privacy@intelius.com` | intelius, zabasearch, anywho, addresses-com, us-search |
| `privacy@verisk.com` | verisk, infutor, verisk-iso |
| `privacy.information.mgr@lexisnexis.com` | lexisnexis, lexisnexis-aplus, lexisnexis-clue |
| `optout@experian.com` | experian-marketing, experian-rentbureau, autocheck |
| `support@beenverified.com` | beenverified, (referenced in peoplelooker) |

---

## 6. Data Quality Spot Check Results

Brokers verified via web search on 2026-02-26:

| Broker | Domain Active | Email Current | Opt-Out Works | Notes |
|---|---|---|---|---|
| Spokeo | Yes | Yes (`customercare@spokeo.com`) | Yes | Opt-out page confirmed at spokeo.com/optout |
| Acxiom | Yes | Yes (`consumeradvo@acxiom.com`) | Yes | Portal at isapps.acxiom.com/optout/optout.aspx confirmed |
| ZoomInfo | Yes | Yes (`privacy@zoominfo.com`) | Yes | Privacy center at privacyrequest.zoominfo.com confirmed |
| MediaMath | **DEFUNCT** | **DEFUNCT** | **No** | Bankrupt June 2023, acquired by Infillion |
| Oracle Data Cloud | Uncertain | Wrong email | Uncertain | Advertising shut down Sept 2024; opt-out portal may be offline |
| Clearbit | Yes (redirects to HubSpot) | Likely valid | Yes | Acquired by HubSpot Nov 2023, now "Breeze Intelligence" |
| SafeGraph | Yes (data operations) | Likely valid | Uncertain | Spun off data to Advan; some products discontinued |
| Gravy Analytics | Uncertain | Uncertain | Uncertain | FTC banned from selling sensitive data Jan 2025; massive breach Jan 2025 |
| Infutor/Verisk | Yes (`privacy.infutor.com`) | Yes | Yes | Portal still active under Verisk Marketing Solutions branding |
| PeopleConnect | Yes | Yes | Yes | Suppression center confirmed active, covers 15+ brands |
| Lotame | Transitioning | Likely valid | Yes | Being integrated into Epsilon/Publicis; brand may continue |
| Eyeota | Yes | Yes (`privacy@eyeota.com`) | Yes | Operating as D&B company; fast 72-hour removal |

---

## 7. Action Items Summary

### Immediate (CRITICAL fixes):
1. Fix data-aggregator/data-aggregators category mismatch (35 files)
2. Remove or archive MediaMath entry
3. Verify and update Oracle Data Cloud entry
4. Merge Verisk and Infutor entries
5. Add Venntel alias to Gravy Analytics and update FTC enforcement notes

### Short-term (WARNING fixes):
6. Remove conflicting aliases (Acxiom/LiveRamp, TransUnion/Neustar, LexisNexis A-PLUS/CLUE, Lotame/Epsilon)
7. Move TruthFinder to people-search category
8. Add suppression group identifiers for PeopleConnect and BeenVerified networks
9. Fix URL-path aliases to proper domain format
10. Fix Whitepages self-referencing alias

### Medium-term (MISSING brokers):
11. Add Mobilewalla entry
12. Add Venntel entry (or confirm alias of Gravy Analytics)
13. Add Precisely entry
14. Add Experian Consumer Direct entry
15. Add remaining missing major brokers

### Ongoing:
16. Standardize empty aliases to `[]` format
17. Add source citations to entries missing `meta.notes`
18. Monitor Clearbit/HubSpot migration
19. Monitor Lotame/Epsilon integration
20. Document California DROP portal for users

---

*Report generated 2026-02-26. All web verification searches performed same day.*
