"use client";

// Shared "select photos -> move/download/delete" flow used by both v2
// Browse and v2 Organize - same real endpoints (photosApi.bulkMove/
// bulkDelete/downloadMany), same confirm-modal-before-destructive-action
// pattern, same toast (the one global ToastProviderV2 host, not a per-page
// implementation). Factored out once a second real call site needed it.

import { useState } from "react";
import { photosApi } from "@/lib/api";
import { useToast } from "@/components/v2/ToastProviderV2";

export function useBulkPhotoActions(onChanged: () => void) {
  const showToast = useToast();
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  const [bulkMoveTarget, setBulkMoveTarget] = useState("");
  const [bulkMoveBusy, setBulkMoveBusy] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleteBusy, setBulkDeleteBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll(ids: string[]) {
    setSelectedIds(new Set(ids));
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelectedIds(new Set());
  }

  function openBulkMove(targetFolderId: string) {
    setBulkMoveTarget(targetFolderId);
    setBulkError(null);
    setBulkMoveOpen(true);
  }

  async function confirmBulkMove() {
    if (!bulkMoveTarget || bulkMoveBusy) return;
    setBulkMoveBusy(true);
    setBulkError(null);
    try {
      const res = await photosApi.bulkMove([...selectedIds], bulkMoveTarget);
      showToast(`${res.moved.length} moved to "${res.folderName}"${res.failed.length ? `, ${res.failed.length} failed` : ""}`);
      setBulkMoveOpen(false);
      setBulkMoveTarget("");
      exitSelectMode();
      onChanged();
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : "Failed to move photos");
    } finally {
      setBulkMoveBusy(false);
    }
  }

  async function confirmBulkDelete() {
    if (bulkDeleteBusy) return;
    setBulkDeleteBusy(true);
    setBulkError(null);
    try {
      const res = await photosApi.bulkDelete([...selectedIds]);
      showToast(`${res.deleted.length} moved to Trash${res.failed.length ? `, ${res.failed.length} failed` : ""}`);
      setBulkDeleteOpen(false);
      exitSelectMode();
      onChanged();
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : "Failed to delete photos");
    } finally {
      setBulkDeleteBusy(false);
    }
  }

  async function bulkDownload() {
    try {
      await photosApi.downloadMany([...selectedIds]);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Download failed");
    }
  }

  return {
    selectMode,
    setSelectMode,
    selectedIds,
    toggleSelected,
    selectAll,
    exitSelectMode,
    showToast,
    bulkMoveOpen,
    setBulkMoveOpen,
    bulkMoveBusy,
    openBulkMove,
    confirmBulkMove,
    bulkDeleteOpen,
    setBulkDeleteOpen,
    bulkDeleteBusy,
    confirmBulkDelete,
    bulkError,
    bulkDownload,
  };
}
