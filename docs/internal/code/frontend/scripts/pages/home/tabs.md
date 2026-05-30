---
title: frontend/scripts/pages/home/tabs.js
source: ../../../../../../frontend/scripts/pages/home/tabs.js
owner: Torv
section: Internal · Code · Frontend · scripts/pages/home
last modified date: 2026-05-30
---

# tabs.js

## Purpose

Home page tab definitions — slice 4 of the god-object decomposition (first slice on home.js, 1938 LOC).

## Public surface

- HOME_TABS — declarative tab definitions; each entry pairs a tab key with the LIST_VIEWS spec.
- Spec carries: endpoint, columns, sort, paging, optional chart strip, create-modal config.

## Drift-prone areas

- Endpoint contracts with admin/users/companies/files/etc.; backend wire drift breaks the tab.

## Related

- [Frontend pillar landing](../../../../index.md)
