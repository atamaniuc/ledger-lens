// A committed proof that the service-role import boundary is switched on.
//
// This file does the forbidden thing on purpose. The disable comment below
// is what keeps lint green — and because eslint.config.mjs sets
// `reportUnusedDisableDirectives: "error"`, deleting or weakening the rule
// makes that comment unused and turns `task lint` red. Without this file the
// rule could be removed and nothing would notice.
//
// Never imported by anything. It is a lint fixture, not a module.

// eslint-disable-next-line no-restricted-imports -- the fixture is the point; see above
import { createServiceClient } from "@/lib/supabase/service-client";

export const boundaryFixture = typeof createServiceClient;
