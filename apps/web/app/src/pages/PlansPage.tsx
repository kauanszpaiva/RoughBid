import React, { useCallback, useEffect, useRef, useState } from "react";
import { PlansPage as PlansPageContent } from "./PlansPageContent";
import { PricingAddressCard, type PricingAddressChoice } from "../components/PricingAddressCard";
import { ApiError, getPricingContext, resolvePricingAddress, type PricingContext } from "../services/api";

type PlansPageProps = React.ComponentProps<typeof PlansPageContent>;

const pricingErrorText = (error: unknown) => error instanceof Error ? error.message : "Pricing address could not be loaded.";

/**
 * Thin server-trust wrapper around the existing plans workspace. Address
 * resolution intentionally lives outside the already-large plan/takeoff UI.
 */
export const PlansPage: React.FC<PlansPageProps> = (props) => {
  const { project, workspaceId } = props;
  const canWrite = Boolean(props.canWrite);
  const [pricingContext, setPricingContext] = useState<PricingContext | null>(null);
  const [pricingContextError, setPricingContextError] = useState<string | null>(null);
  const requestKeyRef = useRef("");
  const currentRevision = project.revisions.find((revision) => revision.isCurrent) ?? project.revisions[project.revisions.length - 1];
  const readingMarker = `${currentRevision?.remoteFileId ?? ""}:${currentRevision?.aiPlanJobId ?? ""}:${currentRevision?.aiPlanStatus ?? ""}`;
  const contextKey = `${workspaceId ?? ""}:${project.remoteId ?? ""}`;
  requestKeyRef.current = `${contextKey}:${readingMarker}`;

  const loadPricingContext = useCallback(async () => {
    const remoteId = project.remoteId;
    if (!workspaceId || !remoteId) {
      setPricingContext(null);
      setPricingContextError(null);
      return;
    }
    const requestKey = requestKeyRef.current;
    try {
      const value = await getPricingContext(workspaceId, remoteId);
      if (requestKeyRef.current !== requestKey) return;
      setPricingContext(value);
      setPricingContextError(null);
    } catch (error) {
      if (requestKeyRef.current !== requestKey) return;
      if (error instanceof ApiError && error.status === 404) {
        // No trust record exists yet. Do not fabricate one from browser state.
        setPricingContext(null);
        setPricingContextError(null);
        return;
      }
      setPricingContext(null);
      setPricingContextError(pricingErrorText(error));
    }
  }, [workspaceId, project.remoteId]);

  useEffect(() => {
    void loadPricingContext();
  }, [loadPricingContext, readingMarker]);

  const handleResolvePricingAddress = async (choice: PricingAddressChoice) => {
    if (!canWrite || !workspaceId || !project.remoteId) return;
    setPricingContextError(null);
    try {
      await resolvePricingAddress(workspaceId, project.remoteId, choice);
      await loadPricingContext();
    } catch (error) {
      setPricingContextError(pricingErrorText(error));
    }
  };

  return (
    <>
      <PricingAddressCard
        context={pricingContext}
        canWrite={canWrite}
        error={pricingContextError}
        onResolve={handleResolvePricingAddress}
      />
      <PlansPageContent {...props} />
    </>
  );
};
