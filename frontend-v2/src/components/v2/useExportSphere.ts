"use client";

import { useState } from "react";
import { photosApi, searchApi } from "@/lib/api";
import { useToast } from "@/components/v2/ToastProviderV2";

const PAGE = 200;

// "Export my sphere" - no dedicated export endpoint, so this collects every
// real photo id via searchApi.search (paginating through the whole
// library) then feeds them into the same real photosApi.downloadMany used
// by Browse/Organize's bulk download, producing one real zip of everything.
export function useExportSphere() {
  const showToast = useToast();
  const [exporting, setExporting] = useState(false);

  async function exportSphere() {
    if (exporting) return;
    setExporting(true);
    try {
      const ids: string[] = [];
      let offset = 0;
      let total = Infinity;
      while (ids.length < total) {
        const res = await searchApi.search({ limit: PAGE, offset });
        ids.push(...res.photos.map((p) => p.id));
        total = res.total;
        offset += PAGE;
        if (res.photos.length === 0) break;
      }
      if (ids.length === 0) {
        showToast("Nothing to export yet");
        return;
      }
      showToast(`Preparing ${ids.length} photo${ids.length === 1 ? "" : "s"} for download…`);
      await photosApi.downloadMany(ids);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  return { exportSphere, exporting };
}
