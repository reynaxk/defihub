import type { Metadata } from "next";

// robots.txt already disallows crawling these paths; this is the
// page-level belt-and-suspenders Next's own guidance recommends, since a
// crawler that already has a link to an account page (e.g. from a
// referrer header) isn't guaranteed to have checked robots.txt first.
export const NOINDEX: Metadata["robots"] = { index: false, follow: false };
