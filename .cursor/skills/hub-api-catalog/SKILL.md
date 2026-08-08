---
name: hub-api-catalog
description: >-
  Register or update SAP Business Accelerator Hub APIs in the FactoryPilot
  catalog and CAP BusinessObjectConfig. Use when adding Delivery/Sales/PO APIs,
  downloading EDMX, or documenting sandbox Destinations.
---

# Skill: Hub API catalog

1. Open https://api.sap.com and locate the standard API.
2. Download EDMX into `docs/api/hub/<object>/`.
3. Update `docs/api/hub/API_CATALOG.md` with service, entity, sandbox URL, scenario ID.
4. Seed/update CAP `BusinessObjectConfig` to match EDMX exactly.
5. Never commit API keys; document Destination name `SAP_ACCELERATOR_HUB_SANDBOX`.
6. Add a line under CHANGELOG [Unreleased] if a new API folder was added.
