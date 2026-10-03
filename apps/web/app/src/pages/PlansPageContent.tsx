import React, { useState, useEffect, useRef } from "react";
import {
  Upload,
  History,
  Edit2,
  Download,
  Trash2,
  ArrowRight,
  Sparkles,
  Loader2,
} from "lucide-react";
import { Project, PlanRevision } from "../types";
import type { RevisionPatch } from "../utils/projectRevisions";
import { isAiPlanInFlight, presentAiPlanStatus, presentFullTakeoffStatus } from "../utils/aiPlanStatus";
import { BlueprintViewer } from "../components/BlueprintViewer";
import { PhotoTakeoffPanel, type PhotoIntakeState, type PhotoTakeoffHandle } from "../components/PhotoTakeoffPanel";
import { EstimateServicePicker } from "../components/EstimateServicePicker";
import { ESTIMATE_FILE_ACCEPT, estimateServiceScope, splitEstimateFiles } from "../utils/estimateIntake";
import { projectReadiness } from "../utils/projectReadiness";
import { calculateProjectFinancials, formatCurrency } from "../utils/calculations";
import { ConstructionBudgetPanel } from "../components/ConstructionBudgetPanel";
import { FullPurchasePanel } from "../components/FullPurchasePanel";
import { PlanFilesPanel } from "../components/PlanFilesPanel";
import { ReadingOrderPanel, type ReadingOrderHandle } from "../components/ReadingOrderPanel";
import { readFullPurchaseReturn, readReadingOrderReturn } from "../utils/fullPurchaseReturn";
import { fullTakeoffSpendInput } from "../utils/fullTakeoffApproval";
import type { FullTakeoffApprovalProfile, ReadingOrder } from "../services/api";
import { getAiPlanEntitlement, getAiPlanReading, getFullTakeoffRun, createFullTakeoffRun, type PlanReadingFinding, getCapabilities, getReadingQuote, getSavedReadingQuote, payForReading, type ReadingQuote, ApiError, beginDocumentUpload, completeDocumentUpload, createAiPlanReading, createDocumentDownloadUrl, createDocumentPreviewObjectUrl, grantWorkspaceAiConsent } from "../services/api";

interface PlansPageProps {
  initialFiles?: File[] | undefined;
  onInitialFilesHandled?: () => void;
  onOpenResult?: (step: 'quantities' | 'estimate' | 'export') => void;
  canWrite?: boolean;
  onAppendRevision: (revision: PlanRevision) => void;
  onPatchRevision: (revisionId: string, patch: RevisionPatch) => void;
  project: Project;
  workspaceId: string | null;
  onUpdateProject: (updated: Project) => void;
  onContinue: () => void;
  onOpenAIAssistant: () => void;
  onBeforeFullCheckout?: (fileId: string) => Promise<void>;
  onBeforeOrderCheckout?: (fileIds: string[]) => Promise<void>;
}

const PLAN_TRADES = ['Framing', 'Concrete', 'Drywall', 'Electrical', 'Plumbing', 'HVAC', 'Finishes'];

export const PlansPage: React.FC<PlansPageProps> = ({
  initialFiles, onInitialFilesHandled, onOpenResult,
  canWrite = false,
  onAppendRevision,
  onPatchRevision,
  project,
  workspaceId,
  onUpdateProject,
  onContinue,
  onOpenAIAssistant,
  onBeforeFullCheckout,
  onBeforeOrderCheckout,
}) => {
  const [readingQuote, setReadingQuote] = useState<ReadingQuote | null>(null);
  const [quoteRecoveryContext, setQuoteRecoveryContext] = useState<string | null>(null);
  const [quoteRecoveryError, setQuoteRecoveryError] = useState(false);
  const [quoteRecoveryRetry, setQuoteRecoveryRetry] = useState(0);
  const quoteRefreshId = useRef<string | undefined>(undefined);
  // Shared by upload, included analysis, quotes, and Checkout. React state alone
  // cannot exclude a second event before the next render commits.
  const paidActionInFlight = useRef(false);
  const [selectedTrades, setSelectedTrades] = useState(PLAN_TRADES);
  const [photoUploadRequest, setPhotoUploadRequest] = useState<{ id: string; files: File[] }>();
  const [photoIntakeState, setPhotoIntakeState] = useState<PhotoIntakeState>({ busy: false, ready: false, count: 0, error: null });
  const photoPanel = useRef<PhotoTakeoffHandle>(null);
  const readingOrderPanel = useRef<ReadingOrderHandle>(null);
  const initialFilesHandled = useRef<File[] | undefined>(undefined);
  const [processingConsent, setProcessingConsent] = useState(false);
  const consentInput = useRef<HTMLInputElement>(null);
  const [readingProgress, setReadingProgress] = useState<string | null>(null);
  const [readingError, setReadingError] = useState<string | null>(null);
  const services = project.selectedServices ?? [];
  const servicesKey = services.join(',');
  useEffect(() => {
    if (services.length) setSelectedTrades(estimateServiceScope(services).trades);
  }, [servicesKey]);
  const [aiReadingAvailable, setAiReadingAvailable] = useState(false);
  const [fullTakeoffV2, setFullTakeoffV2] = useState(false);
  const [fullTakeoffV2Available, setFullTakeoffV2Available] = useState(false);
  const [processingUnavailableReason, setProcessingUnavailableReason] = useState<string | null>(null);
  const [fullTakeoffPurchaseAvailable, setFullTakeoffPurchaseAvailable] = useState(false);
  const [fullApprovalProfile, setFullApprovalProfile] = useState<FullTakeoffApprovalProfile | null>(null);
  const [fullBudgetAmounts, setFullBudgetAmounts] = useState<Record<string, string>>({});
  const [fullSpendConfirmed, setFullSpendConfirmed] = useState(false);
  const [fullSpendContext, setFullSpendContext] = useState('');
  const [billingAvailable, setBillingAvailable] = useState(false);
  const [fullBillingAvailable, setFullBillingAvailable] = useState(false);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [returnOrderId, setReturnOrderId] = useState<string | null>(null);
  const [recoverLatestOrder, setRecoverLatestOrder] = useState(true);
  const [selectedOrder, setSelectedOrder] = useState<ReadingOrder | null>(null);
  const orderReturn = readReadingOrderReturn(window.location.search);
  useEffect(() => {
    const target = readReadingOrderReturn(window.location.search);
    setReturnOrderId(target?.workspaceId === workspaceId && target.projectId === project.remoteId ? target.orderId : null);
    const ids = project.revisions.filter(revision => revision.remoteFileId && (project.intakeMode === 'quick' || revision.isCurrent)).map(revision => revision.remoteFileId!);
    setSelectedFileIds(ids);
    setRecoverLatestOrder(true);
  }, [workspaceId, project.remoteId]);
  const [findings, setFindings] = useState<PlanReadingFinding[]>([]);
  // Per-workspace entitlement. Never derived from a global flag: a customer
  // workspace must not be shown a free-analysis action it cannot use.
  const [freeReadingAvailable, setFreeReadingAvailable] = useState(false);
  const [pilotActive, setPilotActive] = useState(false);
  const [entitlementContext, setEntitlementContext] = useState<string | null>(null);
  const [entitlementError, setEntitlementError] = useState(false);
  const [entitlementRetry, setEntitlementRetry] = useState(0);
  const entitlementReady = entitlementContext === `${workspaceId}:${project.remoteId}`;
  useEffect(() => { let active = true; getCapabilities().then(value => { if (active) { setAiReadingAvailable(value.aiReadingAvailable); setBillingAvailable(value.billing); setFullBillingAvailable(value.fullTakeoffBilling === true); } }).catch(() => undefined); return () => { active = false; }; }, []);
  useEffect(() => {
    let active = true;
    const remoteId = project.remoteId;
    setEntitlementContext(null);
    setEntitlementError(false);
    setFreeReadingAvailable(false);
    setFullTakeoffV2Available(false); setProcessingUnavailableReason(null);
    setFullTakeoffPurchaseAvailable(false);
    setFullTakeoffV2(false);
    setFullApprovalProfile(null);
    setFullBudgetAmounts({});
    setFullSpendConfirmed(false);
    setPilotActive(false);
    if (!workspaceId || !remoteId) { setFreeReadingAvailable(false); return () => { active = false; }; }
    getAiPlanEntitlement(workspaceId, remoteId)
      .then(value => { if (active) { setFreeReadingAvailable(value.freeReadingAvailable); setFullTakeoffV2Available(value.fullTakeoffV2Available === true); setProcessingUnavailableReason(value.fullTakeoffUnavailableReason ?? null); setFullTakeoffPurchaseAvailable(value.fullTakeoffPurchaseAvailable === true); setFullApprovalProfile(value.fullTakeoffApproval ?? null); setFullBudgetAmounts(Object.fromEntries((value.fullTakeoffApproval?.providers ?? []).map(provider => [provider.provider, String(provider.minimumUsd)]))); setPilotActive(value.pilotActive === true); setEntitlementContext(`${workspaceId}:${remoteId}`); } })
      .catch(() => { if (active) setEntitlementError(true); });
    return () => { active = false; };
  }, [workspaceId, project.remoteId, entitlementRetry]);
  const [isPaying, setIsPaying] = useState(false);
  const [showRevisionsModal, setShowRevisionsModal] = useState<boolean>(false);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [uploadBatch, setUploadBatch] = useState<Array<{ file: File; status: 'pending' | 'uploading' | 'saved' | 'failed'; error?: string | undefined }>>([]);
  const uploadScope = useRef(''); uploadScope.current = `${workspaceId}:${project.remoteId}`;
  useEffect(() => { uploadScope.current = `${workspaceId}:${project.remoteId}`; setUploadBatch([]); setIsUploading(false); return () => { uploadScope.current = ''; }; }, [workspaceId, project.remoteId]);
  const [isStartingAi, setIsStartingAi] = useState<boolean>(false);
  const [needsAiConsent, setNeedsAiConsent] = useState<boolean>(false);
  const [isGrantingAiConsent, setIsGrantingAiConsent] = useState<boolean>(false);
  const [planNotice, setPlanNotice] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [editingFileName, setEditingFileName] = useState<boolean>(false);
  const [newFileName, setNewFileName] = useState<string>("");

  const currentRevision =
    project.revisions.find((r) => r.isCurrent) || project.revisions[project.revisions.length - 1];
  const contextRef = useRef('');
  const contextKey = `${workspaceId}:${project.remoteId}:${currentRevision?.remoteFileId}:${selectedTrades.join(',')}:${fullTakeoffV2}`;
  const fileContextKey = `${workspaceId}:${project.remoteId}:${currentRevision?.remoteFileId}`;
  const fullSpendApproval = fullTakeoffSpendInput(fullApprovalProfile, fullBudgetAmounts, fullSpendConfirmed && fullSpendContext === fileContextKey);
  const paidReading = entitlementReady && !freeReadingAvailable && !fullTakeoffV2Available && !pilotActive;
  const quoteRecoveryReady = quoteRecoveryContext === fileContextKey;
  contextRef.current = contextKey;

  useEffect(() => { setReadingQuote(null); quoteRefreshId.current = undefined; setPlanNotice(null); setNeedsAiConsent(false); setIsStartingAi(false); }, [workspaceId, project.remoteId, currentRevision?.remoteFileId]);
  useEffect(() => { setFullBudgetAmounts(Object.fromEntries((fullApprovalProfile?.providers ?? []).map(provider => [provider.provider, String(provider.minimumUsd)]))); setFullSpendConfirmed(false); setProcessingConsent(false); }, [fileContextKey, fullApprovalProfile]);
  useEffect(() => { contextRef.current = contextKey; return () => { contextRef.current = ''; }; }, [contextKey]);

  // Returning from Checkout or reloading only reads persisted state. The
  // original paid scope is restored; no quote, payment or AI job is created.
  useEffect(() => {
    let active = true;
    setQuoteRecoveryContext(null);
    setQuoteRecoveryError(false);
    if (!paidReading || !canWrite || !workspaceId || !project.remoteId || !currentRevision?.remoteFileId) return () => { active = false; };
    getSavedReadingQuote(workspaceId, project.remoteId, currentRevision.remoteFileId, quoteRefreshId.current)
      .then(quote => {
        if (!active) return;
        setReadingQuote(quote);
        if (quote) setSelectedTrades(quote.trades);
        setQuoteRecoveryContext(fileContextKey);
      })
      .catch(() => { if (active) setQuoteRecoveryError(true); });
    return () => { active = false; };
  }, [paidReading, canWrite, workspaceId, project.remoteId, currentRevision?.remoteFileId, quoteRecoveryRetry]);

  const refreshSavedQuote = () => {
    quoteRefreshId.current = readingQuote?.id;
    setQuoteRecoveryRetry(value => value + 1);
  };

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastObservedStatus = currentRevision?.aiPlanStatus;
    let lastRevisionNote = currentRevision?.notes;
    setFindings([]); setReadingProgress(null); setReadingError(null);
    const jobId = currentRevision?.aiPlanJobId;
    if (!workspaceId || !jobId || !currentRevision) {
      return () => { active = false; };
    }

    const pollAiPlanReading = async () => {
      try {
        if (currentRevision.aiPlanMode === 'full_v2') {
          const polledRun = await getFullTakeoffRun(workspaceId, jobId);
          if (!active) return;
          const presentation = presentFullTakeoffStatus(polledRun);
          setReadingProgress(presentation.savedProgress);
          setReadingError(polledRun.processing_error ?? null);
          if (lastObservedStatus !== polledRun.status || (presentation.revisionNote && lastRevisionNote !== presentation.revisionNote)) {
            onPatchRevision(currentRevision.id, {
              aiPlanJobId: polledRun.id, aiPlanStatus: polledRun.status, aiPlanMode: 'full_v2',
              ...(presentation.revisionNote ? { notes: presentation.revisionNote } : {}),
            });
            lastObservedStatus = polledRun.status;
            if (presentation.revisionNote) lastRevisionNote = presentation.revisionNote;
          }
          setPlanNotice(polledRun.processing_error ? `${presentation.notice} ${polledRun.processing_error}` : presentation.notice);
          if (isAiPlanInFlight(polledRun.status)) timer = setTimeout(pollAiPlanReading, 4000);
          return;
        }
        const polledJob = await getAiPlanReading(workspaceId, jobId);
        if (!active) return;
        setFindings(polledJob.plan_reading_findings);
        setReadingError(polledJob.processing_error ?? null);
        const presentation = presentAiPlanStatus(polledJob.status);
        if (lastObservedStatus !== polledJob.status || (presentation.revisionNote && lastRevisionNote !== presentation.revisionNote)) {
          onPatchRevision(currentRevision.id, {
            aiPlanJobId: polledJob.id,
            aiPlanStatus: polledJob.status,
            aiPlanMode: currentRevision.aiPlanMode ?? 'quick',
            ...(presentation.revisionNote ? { notes: presentation.revisionNote } : {}),
          });
          lastObservedStatus = polledJob.status;
          if (presentation.revisionNote) lastRevisionNote = presentation.revisionNote;
        }
        setReadingQuote((current) => current?.job_id === polledJob.id && current.status !== 'revoked'
          ? { ...current, status: polledJob.status === 'failed' ? 'failed' : presentation.finished ? 'complete' : 'processing' }
          : current);
        if (polledJob.status === 'failed') {
          setPlanNotice(`AI plan reading failed${polledJob.processing_error ? `: ${polledJob.processing_error}` : '.'}`);
          return;
        }
        setPlanNotice(presentation.notice);
        if (polledJob.status === 'queued' || polledJob.status === 'processing') {
          timer = setTimeout(pollAiPlanReading, 4000);
        }
      } catch (error) {
        if (active) {
          setReadingError(`Progress could not be refreshed. The worker may still be running. ${readableApiError(error)}`);
          setPlanNotice(`Saved progress could not be refreshed. The worker may still be running. ${readableApiError(error)}`);
          if (!(error instanceof ApiError && [401, 403, 404].includes(error.status))) timer = setTimeout(pollAiPlanReading, 8000);
        }
      }
    };

    void pollAiPlanReading();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [workspaceId, currentRevision?.id, currentRevision?.aiPlanJobId, currentRevision?.aiPlanMode]);

  useEffect(() => {
    let canceled = false;
    setPreviewError(null);
    if (!currentRevision) {
      setPreviewUrl(null);
      setIsPreviewLoading(false);
      return;
    }
    if (currentRevision.fileUrl && !currentRevision.remoteFileId) {
      setPreviewUrl(currentRevision.fileUrl);
      setIsPreviewLoading(false);
      return;
    }
    if (!workspaceId || !currentRevision.remoteFileId) {
      setPreviewUrl(null);
      setIsPreviewLoading(false);
      setPreviewError("This plan is saved locally only. Upload it to a workspace to preview it here.");
      return;
    }
    let objectUrl: string | null = null;
    setPreviewUrl(null);
    setIsPreviewLoading(true);
    createDocumentPreviewObjectUrl(workspaceId, currentRevision.remoteFileId)
      .then((url) => {
        objectUrl = url;
        if (!canceled) setPreviewUrl(url);
        else URL.revokeObjectURL(url);
      })
      .catch((error) => {
        if (!canceled) setPreviewError(readableApiError(error));
      })
      .finally(() => {
        if (!canceled) setIsPreviewLoading(false);
      });
    return () => {
      canceled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [workspaceId, currentRevision?.id, currentRevision?.fileUrl, currentRevision?.remoteFileId]);
  const handlePay = async () => {
    if (!canWrite || paidActionInFlight.current || isUploading || isStartingAi || isPaying) return;
    if (!workspaceId || !project.remoteId || !readingQuote) return;
    paidActionInFlight.current = true;
    setIsPaying(true);
    try { const checkout = await payForReading(workspaceId, project.remoteId, readingQuote.id); if (contextRef.current === contextKey) window.location.assign(checkout.url); }
    catch (error) { setPlanNotice(readableApiError(error)); }
    finally { paidActionInFlight.current = false; setIsPaying(false); }
  };

  // Handle uploading a new plan revision
  const readableApiError = (error: unknown) => {
    if (error instanceof ApiError) {
      try {
        const parsed = JSON.parse(error.message);
        return typeof parsed.error === "string" ? parsed.error : error.message;
      } catch {
        return error.message;
      }
    }
    return error instanceof Error ? error.message : "Action failed.";
  };

  const applyNewRevision = (newRev: PlanRevision) => {
    if (!canWrite) return;
    onAppendRevision(newRev);
  };

  const uploadFiles = async (files: File[], retry = false) => {
    if (!canWrite || paidActionInFlight.current || isUploading || isStartingAi || isPaying) return;
    if (!files.length) return;
    if (!workspaceId || !project.remoteId) {
      setPlanNotice("Wait for the project to finish saving, then upload your PDFs.");
      return;
    }
    const scope = `${workspaceId}:${project.remoteId}`;
    const current = () => uploadScope.current === scope;
    if (!retry) { setUploadBatch(files.map(file => ({ file, status: 'pending' }))); setSelectedFileIds([]); setReturnOrderId(null); setRecoverLatestOrder(false); }
    const update = (file: File, status: 'pending' | 'uploading' | 'saved' | 'failed', error?: string) => {
      if (current()) setUploadBatch(items => items.map(item => item.file === file ? { ...item, status, error } : item));
    };
    paidActionInFlight.current = true;
    setIsUploading(true);
    setPlanNotice(null);
    let savedCount = 0;
    try {
      for (const file of files) {
        if (!current()) break;
        update(file, 'uploading');
        try {
          if ((file.type && file.type !== 'application/pdf') || !file.name.toLowerCase().endsWith('.pdf')) throw new Error('Choose a PDF. Use the Photos section for images.');
          if (file.size > 50 * 1024 * 1024) throw new Error('Choose a PDF no larger than 50 MB.');
          const remote = await beginDocumentUpload(workspaceId, project.remoteId, { name: file.name, contentType: 'application/pdf', byteSize: file.size });
          if (!current()) break;
          const uploaded = await fetch(remote.upload.url, { signal: AbortSignal.timeout(120_000), method: remote.upload.method, headers: remote.upload.headers, body: file });
          if (!uploaded.ok) throw new Error(`Private plan upload failed (${uploaded.status})`);
          const completed = await completeDocumentUpload(workspaceId, remote.file.id);
          if (!current()) break;
          const nextRevNum = String(project.revisions.length + savedCount + 1).padStart(2, '0');
          applyNewRevision({ id: `rev-${completed.id}`, revisionNumber: nextRevNum, fileName: file.name,
            fileSize: `${(file.size / (1024 * 1024)).toFixed(1)} MB`, pages: completed.page_count ?? 0,
            uploadDate: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
            uploadedBy: 'Estimator', isCurrent: true, remoteFileId: completed.id, processingStatus: completed.processing_status,
            notes: 'PDF saved privately. Select this file to see its reading price or add measurements manually.' });
          savedCount++;
          setSelectedFileIds(previous => [...previous, completed.id].slice(0, 20));
          update(file, 'saved');
        } catch (error) {
          update(file, 'failed', error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
            ? 'The upload timed out. Retry this file.' : readableApiError(error));
        }
      }
      if (current()) setPlanNotice(`${savedCount} of ${files.length} PDFs saved. Reading has not started. Confirm processing and select Generate estimate to continue.`);
    } finally {
      paidActionInFlight.current = false;
      if (current()) setIsUploading(false);
    }
  };
  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    void uploadFiles(files);
  };

  const uploadIntakeFiles = async (files: File[]) => {
    if (!canWrite || paidActionInFlight.current || isUploading || isStartingAi || isPaying || photoIntakeState.busy) return;
    try {
      const batch = splitEstimateFiles(files);
      if (batch.photos.length) setPhotoUploadRequest({ id: crypto.randomUUID(), files: batch.photos });
      if (batch.plans.length) await uploadFiles(batch.plans);
    } catch (error) { setPlanNotice(readableApiError(error)); }
  };
  const handleIntakeSelection = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (files.length) void uploadIntakeFiles(files);
  };
  useEffect(() => {
    if (!initialFiles?.length || initialFilesHandled.current === initialFiles || !canWrite || !workspaceId || !project.remoteId) return;
    initialFilesHandled.current = initialFiles;
    void uploadIntakeFiles(initialFiles);
    onInitialFilesHandled?.();
  }, [initialFiles, canWrite, workspaceId, project.remoteId]);

  const handleGenerateEstimate = async () => {
    if (!canWrite || !entitlementReady || !workspaceId || !project.remoteId || paidActionInFlight.current || isUploading || isStartingAi || isPaying || photoIntakeState.busy) return;
    if (!services.length) { setPlanNotice('Choose the work to estimate before starting the reading.'); return; }
    if (!processingConsent) { setPlanNotice('Your files are saved, but reading has not started. Confirm AI processing below, then select Generate estimate.'); consentInput.current?.focus(); consentInput.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
    const selected = estimateServiceScope(services);
    setReadingError(null);
    const captured = `${workspaceId}:${project.remoteId}`;
    const relevant = project.revisions.filter(revision => revision.remoteFileId && selectedFileIds.includes(revision.remoteFileId));
    if (!relevant.length && !photoIntakeState.count) { setPlanNotice('Add photos or select a saved PDF to generate your estimate.'); return; }
    if (uploadBatch.some(item => item.status === 'failed')) { setPlanNotice('Complete the pending uploads before generating the estimate.'); return; }
    // Let the purchase panel own its shared lock and saved order recovery. The
    // main intake action prepares a quote; payment still needs price approval.
    if (relevant.length && fullTakeoffPurchaseAvailable && !freeReadingAvailable && !fullTakeoffV2Available) {
      setPlanNotice(null);
      try {
        if (!readingOrderPanel.current) throw new Error('Your saved purchase is still loading. Try again when its status is ready.');
        await readingOrderPanel.current.prepare();
        if (uploadScope.current === captured && photoIntakeState.count) await photoPanel.current?.generate();
      } catch (error) { if (uploadScope.current === captured) setPlanNotice(readableApiError(error)); }
      return;
    }
    paidActionInFlight.current = true; setIsStartingAi(true); setPlanNotice(null);
    try {
      await grantWorkspaceAiConsent(workspaceId);
      if (uploadScope.current !== captured) return;
      // Owner/pilot entitlement and all commercial limits are checked again by
      // the existing API. No payment or provider budget bypass is introduced.
      if (freeReadingAvailable || fullTakeoffV2Available) {
        for (const revision of relevant) {
          if (uploadScope.current !== captured) return;
          if (revision.processingStatus === 'uploading' || revision.processingStatus === 'failed') throw new Error(`${revision.fileName} has not finished uploading.`);
          if (fullTakeoffV2Available && !fullApprovalProfile && !freeReadingAvailable) throw new Error('Full-plan processing limits are unavailable. Refresh access before starting.');
          const deep = fullTakeoffV2Available && Boolean(fullApprovalProfile);
          const signature = deep ? 'full-document' : `${[...selected.trades].sort().join(',')}:${selected.scope}`;
          if (revision.aiPlanJobId && revision.aiPlanRequestScope === signature && ['queued', 'processing', 'waiting_budget', 'ready', 'needs_review'].includes(revision.aiPlanStatus ?? '')) continue;
          const approval = deep ? fullTakeoffSpendInput(fullApprovalProfile, fullBudgetAmounts, processingConsent) : null;
          if (deep && !approval) throw new Error('Confirm valid processing limits for each provider before starting.');
          const job = deep ? await createFullTakeoffRun(workspaceId, project.remoteId, revision.remoteFileId!, approval!)
            : await createAiPlanReading(workspaceId, project.remoteId, { file_id: revision.remoteFileId!, mode: 'quick', trades: selected.trades, scope: selected.scope });
          if (uploadScope.current !== captured) return;
          onPatchRevision(revision.id, { aiPlanJobId: job.id, aiPlanStatus: job.status, aiPlanMode: deep ? 'full_v2' : 'quick', aiPlanRequestScope: signature });
          if (revision.id === currentRevision?.id && 'plan_reading_findings' in job) setFindings(job.plan_reading_findings);
        }
      } else if (relevant.length) {
        if (!aiReadingAvailable) throw new Error(processingUnavailableReason === 'worker_unavailable' ? 'Plan reading is temporarily offline. Your files are saved. Check processing availability again after the service restarts.' : 'Plan processing is unavailable. Your saved files remain accessible.');
        if (relevant.length > 1) {
          setPlanNotice('Review the saved multi-file processing fee below before starting.');
        } else {
          setReadingQuote(await getReadingQuote(workspaceId, project.remoteId, relevant[0]!.remoteFileId!, selected.scope, selected.trades));
          setPlanNotice('Review the processing fee below and confirm payment to start.');
        }
      }
      if (photoIntakeState.count) await photoPanel.current?.generate();
      if (uploadScope.current === captured && (freeReadingAvailable || fullTakeoffV2Available)) setPlanNotice('Your reading requests are saved. Follow the results and any missing measurements or prices below.');
    } catch (error) { if (uploadScope.current === captured) setPlanNotice(readableApiError(error)); }
    finally { paidActionInFlight.current = false; if (uploadScope.current === captured) setIsStartingAi(false); }
  };

  /**
   * Owner-workspace analysis with no quote and no payment. The button is only
   * rendered when the authenticated entitlement said yes, and the server
   * re-checks the allowlist, so a customer reaching here still gets 403.
   */
  const handleStartFreeReading = async () => {
    if (!canWrite || paidActionInFlight.current || isUploading || isStartingAi || isPaying) return;
    if (fullTakeoffV2 && !fullTakeoffV2Available) return;
    if (fullTakeoffV2 && !fullSpendApproval) {
      setPlanNotice('Enter the provider spending limits and approve this reading before starting.');
      return;
    }
    if (!workspaceId || !project.remoteId || !currentRevision?.remoteFileId) {
      setPlanNotice("AI reading requires a signed-in workspace, synced project, and server-uploaded PDF.");
      return;
    }
    paidActionInFlight.current = true;
    setIsStartingAi(true);
    setPlanNotice(null);
    setNeedsAiConsent(false);
    try {
      if (fullTakeoffV2) {
        const run = await createFullTakeoffRun(workspaceId, project.remoteId, currentRevision.remoteFileId, fullSpendApproval!);
        if (contextRef.current !== contextKey) return;
        setFindings([]);
        const presentation = presentFullTakeoffStatus(run);
        onPatchRevision(currentRevision.id, {
          aiPlanJobId: run.id, aiPlanStatus: run.status, aiPlanMode: 'full_v2',
          ...(presentation.revisionNote ? { notes: presentation.revisionNote } : {}),
        });
        setPlanNotice(presentation.notice);
        return;
      }
      const job = await createAiPlanReading(workspaceId, project.remoteId, {
        file_id: currentRevision.remoteFileId,
        mode: "quick",
        trades: selectedTrades,
        scope: project.projectType,
      });
      if (contextRef.current !== contextKey) return;
      setFindings(job.plan_reading_findings);
      const presentation = presentAiPlanStatus(job.status);
      onPatchRevision(currentRevision.id, {
        aiPlanJobId: job.id,
        aiPlanStatus: job.status,
        aiPlanMode: 'quick',
        ...(presentation.revisionNote ? { notes: presentation.revisionNote } : {}),
      });
      setPlanNotice(presentation.notice);
    } catch (error) {
      if (contextRef.current !== contextKey) return;
      if (error instanceof ApiError && [403,409].includes(error.status) && /consent|accept AI|approved/i.test(error.message)) {
        setNeedsAiConsent(true);
        setPlanNotice("This workspace hasn't approved sending plan files to AI yet.");
      } else {
        setPlanNotice(readableApiError(error));
      }
    } finally {
      paidActionInFlight.current = false;
      if (contextRef.current === contextKey) setIsStartingAi(false);
    }
  };

  const handleStartAiReading = async () => {
    if (!canWrite || !quoteRecoveryReady || paidActionInFlight.current || isUploading || isPaying) return;
    if (!workspaceId || !project.remoteId || !currentRevision?.remoteFileId) {
      setPlanNotice("AI reading requires a signed-in workspace, synced project, and server-uploaded PDF.");
      return;
    }
    paidActionInFlight.current = true;
    setIsStartingAi(true);
    setPlanNotice(null);
    setNeedsAiConsent(false);
    try {
      const quote = readingQuote
        ? await getSavedReadingQuote(workspaceId, project.remoteId, currentRevision.remoteFileId, readingQuote.id)
        : await getReadingQuote(workspaceId, project.remoteId, currentRevision.remoteFileId, project.projectType, selectedTrades);
      if (contextRef.current !== contextKey) return;
      if (!quote) throw new Error('This saved price is no longer available. Refresh payment status before continuing.');
      setReadingQuote(quote);
      if (quote.status === 'quoted') { setPlanNotice('Your project processing price is ready. Payment is required before analysis.'); return; }
      if (quote.status === 'revoked') { setPlanNotice('Payment access was revoked. Contact support.'); return; }
      if (quote.job_id && ['processing', 'complete'].includes(quote.status)) {
        const existing = await getAiPlanReading(workspaceId, quote.job_id);
        if (contextRef.current !== contextKey) return;
        const presentation = presentAiPlanStatus(existing.status);
        onPatchRevision(currentRevision.id, {
          aiPlanJobId: existing.id,
          aiPlanStatus: existing.status,
          aiPlanMode: 'quick',
          ...(presentation.revisionNote ? { notes: presentation.revisionNote } : {}),
        });
        setFindings(existing.plan_reading_findings);
        setPlanNotice(presentation.notice);
        return;
      }
      const job = await createAiPlanReading(workspaceId, project.remoteId, {
        file_id: currentRevision.remoteFileId,
        quote_id: quote.id,
        // Full V2 does not inherit this legacy quote's price or attempts.
        mode: "quick",
        scope: quote.scope,
        trades: quote.trades,
      });
      if (contextRef.current !== contextKey) return;
      const presentation = presentAiPlanStatus(job.status);
      setReadingQuote({ ...quote, job_id: job.id, status: job.status === 'failed' ? 'failed' : presentation.finished ? 'complete' : 'processing' });
      setFindings(job.plan_reading_findings);
      onPatchRevision(currentRevision.id, {
        aiPlanJobId: job.id,
        aiPlanStatus: job.status,
        aiPlanMode: 'quick',
        ...(presentation.revisionNote ? { notes: presentation.revisionNote } : {}),
      });
      setPlanNotice(presentation.notice);
    } catch (error) {
      if (contextRef.current !== contextKey) return;
      if (error instanceof ApiError && [403,409].includes(error.status) && /consent|accept AI|approved/i.test(error.message)) {
        setNeedsAiConsent(true);
        setPlanNotice("This workspace hasn't approved sending plan files to AI yet.");
      } else {
        setPlanNotice(readableApiError(error));
      }
    } finally {
      paidActionInFlight.current = false;
      if (contextRef.current === contextKey) setIsStartingAi(false);
    }
  };

  const handleRecalculateQuote = async () => {
    if (!canWrite || !quoteRecoveryReady || !readingQuote || !workspaceId || !project.remoteId || paidActionInFlight.current || isUploading || isPaying) return;
    paidActionInFlight.current = true;
    setIsStartingAi(true);
    setPlanNotice(null);
    try {
      const saved = await getSavedReadingQuote(workspaceId, project.remoteId, readingQuote.file_id, readingQuote.id);
      if (contextRef.current !== contextKey) return;
      if (!saved) throw new Error('This saved price is no longer available. Refresh payment status before continuing.');
      // A delayed webhook may already have paid this quote. Never replace it
      // from stale client state or start a reading while recalculating a price.
      if (saved.status !== 'quoted') { setReadingQuote(saved); return; }
      const quote = await getReadingQuote(workspaceId, project.remoteId, saved.file_id, saved.scope, saved.trades);
      if (contextRef.current === contextKey) setReadingQuote(quote);
    } catch (error) {
      if (contextRef.current === contextKey) setPlanNotice(readableApiError(error));
    } finally {
      paidActionInFlight.current = false;
      if (contextRef.current === contextKey) setIsStartingAi(false);
    }
  };

  const handleGrantAiConsent = async () => {
    if (!canWrite) return;
    if (!workspaceId) return;
    setIsGrantingAiConsent(true);
    try {
      await grantWorkspaceAiConsent(workspaceId);
      setNeedsAiConsent(false);
      setPlanNotice("AI processing approved. Refresh payment & analysis to continue.");
      setEntitlementRetry(value => value + 1);
    } catch (error) {
      setPlanNotice(readableApiError(error));
    } finally {
      setIsGrantingAiConsent(false);
    }
  };

  const handleDownloadOriginal = async () => {
    if (!currentRevision) return;
    if (!workspaceId || !currentRevision.remoteFileId) {
      setPlanNotice("This original file is not saved to your workspace. Upload it again to enable downloads.");
      return;
    }
    try {
      const download = await createDocumentDownloadUrl(workspaceId, currentRevision.remoteFileId);
      window.open(download.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      setPlanNotice(readableApiError(error));
    }
  };

  const handleSetCurrentRevision = (revisionId: string) => {
    if (!canWrite || paidActionInFlight.current || isUploading || isStartingAi || isPaying) return;
    const updatedRevisions = project.revisions.map((r) => ({
      ...r,
      isCurrent: r.id === revisionId,
    }));
    onUpdateProject({ ...project, revisions: updatedRevisions });
    setShowRevisionsModal(false);
  };

  const handleSaveRename = () => {
    if (!canWrite) return;
    if (!newFileName.trim() || !currentRevision) return;
    const updatedRevisions = project.revisions.map((r) =>
      r.id === currentRevision.id ? { ...r, fileName: newFileName.trim() } : r
    );
    onUpdateProject({ ...project, revisions: updatedRevisions });
    setEditingFileName(false);
  };

  const handleDeletePlan = () => {
    if (!canWrite || !currentRevision || paidActionInFlight.current || isUploading || isStartingAi || isPaying) return;
    if (confirm(`Remove ${currentRevision.fileName} from this project's file list? Saved purchases and server evidence are retained.`)) {
      const remaining = project.revisions.filter(revision => revision.id !== currentRevision.id);
      onUpdateProject({ ...project, revisions: remaining.map((revision, index) => ({ ...revision, isCurrent: index === remaining.length - 1 })) });
    }
  };

  const pendingPhotoUpload = Boolean(photoUploadRequest?.files.length && !photoIntakeState.ready && !photoIntakeState.error && !photoIntakeState.runStatus);
  const uploading = isUploading || photoIntakeState.activity === 'upload' || pendingPhotoUpload;
  const starting = isStartingAi || photoIntakeState.activity === 'start';
  const updatingPhotos = photoIntakeState.busy && !uploading && !starting;
  const savedPdfCount = uploadBatch.filter(item => item.status === 'saved').length;
  const uploadFailure = uploadBatch.some(item => item.status === 'failed') || Boolean(photoIntakeState.error);
  const selectedReadingStatus = currentRevision?.aiPlanJobId ? currentRevision.aiPlanStatus : undefined;
  const photoReadingStatus = photoIntakeState.runStatus;
  const readingInFlight = (selectedReadingStatus && isAiPlanInFlight(selectedReadingStatus)) || (photoReadingStatus && isAiPlanInFlight(photoReadingStatus));
  const hasSources = project.revisions.some(item => Boolean(item.remoteFileId)) || photoIntakeState.count > 0;
  const readingServiceOffline = entitlementReady && processingUnavailableReason === 'worker_unavailable' && !freeReadingAvailable && !fullTakeoffV2Available;
  const statusTitle = uploading ? 'Uploading your files…' : starting ? 'Starting your reading…' : updatingPhotos ? 'Updating photo reading…' : readingServiceOffline ? 'Plan reading is temporarily offline' : uploadFailure ? 'Some files need attention' : readingError ? 'Reading needs attention' : readingInFlight ? (selectedReadingStatus === 'waiting_budget' || photoReadingStatus === 'waiting_budget' ? 'Waiting for processing capacity' : selectedReadingStatus === 'queued' || photoReadingStatus === 'queued' ? 'Reading queued' : 'Reading your files…') : ['failed', 'cancelled', 'blocked'].includes(selectedReadingStatus ?? photoReadingStatus ?? '') ? 'Reading stopped — review saved progress' : selectedReadingStatus || photoReadingStatus ? 'Reading results are ready to review' : hasSources ? 'Files saved — reading has not started' : 'Add files to begin';
  const statusBusy = !readingError && !readingServiceOffline && (uploading || starting || updatingPhotos || Boolean(readingInFlight));

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-6xl mx-auto space-y-6 select-none font-sans">
      <header><h2 className="text-xl font-bold text-slate-900">Your estimate</h2><p className="mt-1 text-sm text-slate-600">Upload photos and plans. Choose the service. Generate your estimate.</p></header>
      <section aria-label="Estimate progress" className="rounded-xl border border-blue-200 bg-blue-50 p-4 space-y-2">
        <div role="status" aria-live="polite" className="flex items-center gap-2 font-semibold text-blue-950">{statusBusy && <Loader2 aria-label="Estimate is working" className="h-5 w-5 shrink-0 animate-spin" />}{statusTitle}</div>
        {isUploading && <p className="break-words text-sm text-blue-900">{savedPdfCount} of {uploadBatch.length} PDFs saved. {uploadBatch.find(item => item.status === 'uploading')?.file.name}</p>}
        {isUploading && uploadBatch.length > 0 && <progress aria-label="PDF upload progress" value={savedPdfCount} max={uploadBatch.length} className="w-full" />}
        {readingProgress && !uploading && <p className="text-sm text-blue-900">{readingProgress}</p>}
        {photoIntakeState.progress && !uploading && <p className="text-sm text-blue-900">{photoIntakeState.progress}</p>}
        {readingServiceOffline && <div className="text-sm text-blue-900 space-y-2"><p>Your PDFs are saved. Reading cannot start until the processing service is back online.</p><button type="button" onClick={() => setEntitlementRetry(value => value + 1)} className="font-semibold underline">Check processing availability</button></div>}
        {readingError && <p role="alert" className="break-words text-sm text-amber-950">{readingError}</p>}
        {!uploading && !isStartingAi && !selectedReadingStatus && !photoReadingStatus && !readingServiceOffline && hasSources && <p className="text-sm text-blue-900">{!services.length ? 'Choose the service, then start the reading.' : !processingConsent ? 'Confirm AI processing below, then select Generate estimate.' : 'Select Generate estimate to start reading the saved files.'} <a href="#generate-estimate" className="font-semibold underline">Go to Generate estimate</a></p>}
        {statusBusy && <p className="text-xs text-blue-900">{uploading ? 'Keep this page open until the upload finishes.' : 'Saved reading progress remains available when you return. Uploading a file alone does not start AI processing.'}</p>}
      </section>
      <section aria-label="Generate an estimate" className="grid gap-5 rounded-xl border border-slate-200 bg-white p-4 sm:p-6 lg:grid-cols-2">
        <div className="space-y-3"><h3 className="text-sm font-semibold">1. Photos and/or PDF plans</h3>
          <label className="block cursor-pointer rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 p-5 text-center text-sm font-semibold">
            <Upload className="mx-auto mb-2 h-6 w-6 text-brand-500" />Add files
            <input aria-label="Add photos and PDF plans" type="file" accept={ESTIMATE_FILE_ACCEPT} multiple onChange={handleIntakeSelection} className="mt-3 block w-full text-xs" disabled={!canWrite || isUploading || isStartingAi || isPaying || photoIntakeState.busy || !workspaceId || !project.remoteId} />
          </label>
          <label className="block text-sm text-brand-700">Take a photo<input aria-label="Take a construction photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={handleIntakeSelection} disabled={!canWrite || isUploading || isStartingAi || isPaying || photoIntakeState.busy} className="mt-1 block w-full text-xs" /></label>
          <p className="text-xs text-slate-500">PDF, JPEG, PNG and WebP. You can combine plans and site photos.</p>
        </div>
        <div className="space-y-4"><p className="text-xs font-semibold text-brand-600">2. Select the work</p>
          <EstimateServicePicker selected={services} disabled={!canWrite || isUploading || isStartingAi || isPaying || photoIntakeState.busy} onChange={ids => {
            setReadingQuote(null); setProcessingConsent(false);
            if (ids.length) setSelectedTrades(estimateServiceScope(ids).trades);
            onUpdateProject({ ...project, selectedServices: ids, ...(ids.length ? { projectType: estimateServiceScope(ids).scope } : {}) });
          }} />
          {fullTakeoffV2Available && fullApprovalProfile && selectedFileIds.length > 0 && <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs space-y-2">
            <p className="font-medium">Full-plan reading: maximum ${fullApprovalProfile.providers.reduce((sum, provider) => sum + Number(fullBudgetAmounts[provider.provider] || 0), 0).toFixed(2)} per PDF; up to ${(fullApprovalProfile.providers.reduce((sum, provider) => sum + Number(fullBudgetAmounts[provider.provider] || 0), 0) * selectedFileIds.length).toFixed(2)} for {selectedFileIds.length} selected PDF(s).</p>
            <details><summary className="cursor-pointer">Change processing limits</summary><div className="mt-2 space-y-2">{fullApprovalProfile.providers.map(provider => <label key={provider.provider} className="block">{provider.provider} (${provider.minimumUsd}–${provider.maximumUsd} per PDF)<input aria-label={`Estimate ${provider.provider} processing limit USD`} type="number" min={provider.minimumUsd} max={provider.maximumUsd} step="0.000001" value={fullBudgetAmounts[provider.provider] ?? ''} disabled={!canWrite || isStartingAi || isPaying} onChange={event => { setFullBudgetAmounts(previous => ({ ...previous, [provider.provider]: event.target.value })); setProcessingConsent(false); }} className="mt-1 block w-full rounded border p-2" /></label>)}</div></details>
            <p>These limits fund processing, not construction work. A run pauses if its limit is reached.</p>
          </div>}
          <label className="flex items-start gap-2 text-xs text-slate-600"><input ref={consentInput} type="checkbox" checked={processingConsent} disabled={!canWrite || isStartingAi || isPaying} onChange={event => setProcessingConsent(event.target.checked)} /><span>I agree to AI processing of these files and authorize the processing limits shown above, if applicable. Any customer processing fee must be confirmed before payment.</span></label>
          <button id="generate-estimate" type="button" onClick={() => void handleGenerateEstimate()} disabled={!canWrite || !entitlementReady || isUploading || isStartingAi || isPaying || photoIntakeState.busy} aria-busy={isStartingAi} className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-500 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"><Sparkles className="h-4 w-4" />{isStartingAi ? <><Loader2 className="h-4 w-4 animate-spin" />Starting your reading…</> : '3. Generate estimate'}</button>
          {!entitlementReady && <p role="status" className="text-xs text-slate-600">{entitlementError ? <button type="button" onClick={() => setEntitlementRetry(value => value + 1)}>Check processing access again</button> : 'Checking processing access…'}</p>}
          {photoIntakeState.error && <p role="alert" className="text-xs text-amber-900">{photoIntakeState.error}</p>}
        </div>
      </section>
      {planNotice && <p role="status" className="rounded-lg bg-blue-50 p-3 text-sm text-blue-900">{planNotice}</p>}
      <section aria-label="Estimate delivery" className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
        <h3 className="font-semibold">Your results</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <button type="button" onClick={() => onOpenResult?.('estimate')} className="rounded-lg border border-slate-200 p-4 text-left"><span className="block text-xs text-slate-500">Estimate value</span><strong className="mt-1 block text-lg">{projectReadiness(project).hasEstimate ? formatCurrency(calculateProjectFinancials(project.estimateItems, project.overheadPercentage, project.markupPercentage).finalPrice) : 'Pricing pending'}</strong><span className="block text-xs text-slate-500">Materials, labor and markup</span></button>
          <button type="button" onClick={() => onOpenResult?.('quantities')} className="rounded-lg border border-slate-200 p-4 text-left"><span className="block text-xs text-slate-500">Measurements</span><strong className="mt-1 block text-lg">{project.quantities.length ? `${project.quantities.length} saved items` : 'Measurements pending'}</strong><span className="block text-xs text-slate-500">Areas, lengths and counts</span></button>
          <button type="button" onClick={() => onOpenResult?.('export')} className="rounded-lg border border-slate-200 p-4 text-left"><span className="block text-xs text-slate-500">Proposal and materials</span><strong className="mt-1 block text-lg">{projectReadiness(project).canExport ? 'Ready to export' : 'Details pending'}</strong><span className="block text-xs text-slate-500">PDF and spreadsheet</span></button>
        </div>
        <p className="text-xs text-slate-500">Missing measurements and source prices stay pending. Review the saved evidence below.</p>
      </section>
      <PlanFilesPanel workspaceId={workspaceId} projectId={project.remoteId} revisions={project.revisions} selectedId={currentRevision?.id}
        selectedOrder={selectedOrder}
        selectedFileIds={selectedFileIds} onToggle={(fileId, selected) => { setReturnOrderId(null); setRecoverLatestOrder(false); setSelectedFileIds(previous => selected ? [...new Set([...previous, fileId])].slice(0, 20) : previous.filter(id => id !== fileId)); }}
        disabled={!canWrite || isUploading || isStartingAi || isPaying} onSelect={(revision, run, open) => {
          onUpdateProject({ ...project, revisions: project.revisions.map(item => ({ ...item, isCurrent: item.id === revision.id,
            ...(run && item.id === revision.id ? { aiPlanJobId: run.id, aiPlanMode: 'full_v2' as const, aiPlanStatus: run.status } : {}) })) });
          if (open) onOpenAIAssistant();
        }} />
      {uploadBatch.length > 0 && <section aria-label="PDF upload progress" className="rounded-xl border border-slate-200 bg-white p-4 text-sm space-y-2">
        <h3 className="font-semibold">PDF uploads</h3><ul className="space-y-1">{uploadBatch.map((item, index) => <li key={index} className="break-words"><strong>{item.file.name}</strong> — {item.status === 'saved' ? 'Saved' : item.status === 'failed' ? 'Upload pending' : item.status}{item.error ? `: ${item.error}` : ''}</li>)}</ul>
        {uploadBatch.some(item => item.status === 'failed') && <button type="button" disabled={isUploading || isStartingAi || isPaying} onClick={() => void uploadFiles(uploadBatch.filter(item => item.status === 'failed').map(item => item.file), true)} className="underline disabled:opacity-50">Retry failed uploads</button>}
      </section>}
      {entitlementReady && workspaceId && project.remoteId && (selectedFileIds.length > 0 || returnOrderId) && <ReadingOrderPanel key={`order:${workspaceId}:${project.remoteId}:${[...selectedFileIds].sort().join(',')}:${returnOrderId ?? ''}`}
        ref={readingOrderPanel} workspaceId={workspaceId} projectId={project.remoteId} fileIds={selectedFileIds} revisions={project.revisions} returnOrderId={returnOrderId}
        recoverLatest={recoverLatestOrder}
        returned={returnOrderId ? orderReturn?.payment : undefined} available={fullTakeoffPurchaseAvailable} billingAvailable={fullBillingAvailable}
        canWrite={canWrite} externallyBusy={isUploading || isStartingAi || isPaying} actionLock={paidActionInFlight} onBusy={setIsPaying}
        onConsentRequired={() => setNeedsAiConsent(true)} onRestoreSelection={setSelectedFileIds}
        onOrderLoaded={setSelectedOrder}
        beforeCheckout={async fileIds => {
          const captured = `${workspaceId}:${project.remoteId}`;
          if (!onBeforeOrderCheckout) throw new Error('Save this project before opening checkout.');
          await onBeforeOrderCheckout(fileIds);
          if (uploadScope.current !== captured) throw new Error('The active project changed. Review its purchase before continuing.');
          await grantWorkspaceAiConsent(workspaceId);
          if (uploadScope.current !== captured) throw new Error('The active project changed. Review its purchase before continuing.');
        }}
        onOpen={(fileId, run) => {
          onUpdateProject({ ...project, revisions: project.revisions.map(item => ({ ...item, isCurrent: item.remoteFileId === fileId,
            ...(item.remoteFileId === fileId ? { aiPlanJobId: run.id, aiPlanMode: 'full_v2' as const, aiPlanStatus: run.status } : {}) })) });
          onOpenAIAssistant();
        }} />}
      {entitlementReady && readFullPurchaseReturn(window.location.search) && workspaceId && project.remoteId && currentRevision?.remoteFileId && <FullPurchasePanel
        key={`full-purchase:${fileContextKey}`} workspaceId={workspaceId} projectId={project.remoteId} fileId={currentRevision.remoteFileId}
        fileName={currentRevision.fileName} revisionName={currentRevision.revisionNumber}
        canWrite={canWrite} available={fullTakeoffPurchaseAvailable && currentRevision.processingStatus === 'ready'} billingAvailable={fullBillingAvailable}
        complimentaryAvailable={freeReadingAvailable || fullTakeoffV2Available || pilotActive}
        externallyBusy={isUploading || isStartingAi || isPaying} actionLock={paidActionInFlight} onBusyChange={setIsPaying}
        onConsentRequired={() => setNeedsAiConsent(true)}
        beforeCheckout={onBeforeFullCheckout ?? (async () => { throw new Error('Save this project before opening checkout.'); })}
        onRun={(run, open) => {
          onPatchRevision(currentRevision.id, { aiPlanJobId: run.id, aiPlanStatus: run.status, aiPlanMode: 'full_v2' });
          if (open) onOpenAIAssistant();
        }}
      />}
      {paidReading && canWrite && currentRevision?.remoteFileId && !quoteRecoveryReady && <p role="status" className="text-sm text-slate-600">{quoteRecoveryError ? <button onClick={refreshSavedQuote}>Payment status could not be loaded. Retry.</button> : 'Loading saved payment status…'}</p>}
      {paidReading && quoteRecoveryReady && readingQuote && readingQuote.file_id === currentRevision?.remoteFileId && <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-3" aria-label="Project payment">
        <div className="flex flex-wrap justify-between gap-3"><div><h3 className="font-bold">Project processing fee</h3><p className="text-sm text-slate-600">{readingQuote.page_count} pages · {readingQuote.trades.join(', ')}</p></div>
          <strong className="text-xl">{new Intl.NumberFormat('en-US',{style:'currency',currency:readingQuote.currency}).format(readingQuote.amount_cents/100)}</strong></div>
        {readingQuote.scope && <p className="text-sm text-slate-600">Saved scope: {readingQuote.scope}</p>}
        <p className="text-xs text-slate-600">Includes one completed reading and up to two attempts if processing fails. Changes to the plan or scope need a new price. Membership savings are included when active.</p>
        <p className="text-sm">{readingQuote.status === 'quoted' ? 'Awaiting payment' : readingQuote.status === 'complete' ? 'Reading ready to review' : readingQuote.status === 'processing' ? 'Reading in progress' : readingQuote.status === 'failed' ? 'Reading failed — no substitute quantities were generated' : readingQuote.status === 'revoked' ? 'Payment access revoked' : 'Payment confirmed'}</p>
        <div className="flex gap-3 flex-wrap">
          {readingQuote.status === 'quoted' && <><button onClick={handlePay} disabled={!canWrite || !billingAvailable || isPaying || isStartingAi || isUploading} className="rounded-lg bg-blue-600 text-white px-4 py-2 disabled:opacity-50">{isPaying ? 'Opening checkout…' : 'Pay securely with Stripe'}</button><button onClick={handleRecalculateQuote} disabled={!canWrite || isStartingAi || isPaying || isUploading} className="rounded-lg border px-4 py-2 disabled:opacity-50">Recalculate project price</button></>}
          <button onClick={refreshSavedQuote} disabled={isStartingAi || isPaying || isUploading} className="rounded-lg border px-4 py-2 disabled:opacity-50">Refresh payment status</button>
          {!['quoted', 'revoked'].includes(readingQuote.status) && <button onClick={handleStartAiReading} disabled={!canWrite || (!aiReadingAvailable && !['processing', 'complete'].includes(readingQuote.status)) || isStartingAi || isPaying || isUploading || (readingQuote.status === 'failed' && readingQuote.attempts >= readingQuote.max_attempts)} className="rounded-lg border px-4 py-2 disabled:opacity-50">{isStartingAi ? 'Checking / processing…' : ['processing', 'complete'].includes(readingQuote.status) ? 'Open saved reading' : readingQuote.status === 'failed' ? 'Retry paid analysis' : 'Start paid analysis'}</button>}
        </div>
      </section>}
      <details open={needsAiConsent || undefined} className="rounded-xl border border-slate-200 bg-white p-4">
      <summary className="cursor-pointer text-sm font-semibold text-slate-700">Plan viewer and advanced reading tools</summary>
      {/* Title & Subtitle */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">
            Selected PDF
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Preview the source file or use the manual measurement tools.
          </p>
        </div>

        {/* AI Assistant Quick Trigger */}
        <button
          onClick={onOpenAIAssistant}
          disabled={!canWrite || !currentRevision}
          className="self-start sm:self-auto flex items-center gap-1.5 px-3 py-1.5 bg-brand-50 border border-blue-200 text-brand-500 hover:bg-blue-100 rounded-md text-xs font-semibold transition cursor-pointer"
        >
          <Sparkles className="w-3.5 h-3.5 text-brand-500" />
          <span>View selected PDF results</span>
        </button>
      </div>

      {/* Main Grid: Blueprint Viewer on Left, Details & Actions on Right */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Cols: Interactive PDF/Plan Canvas */}
        <div className="lg:col-span-2">
          {currentRevision ? (
            <BlueprintViewer
              currentRevision={currentRevision}
              projectName={project.name}
              previewUrl={previewUrl}
              isPreviewLoading={isPreviewLoading}
              previewError={previewError}
              onAnnotationsChange={(annotations) => onUpdateProject({ ...project, revisions: project.revisions.map(revision => revision.id === currentRevision.id ? { ...revision, annotations } : revision) })}
              canWrite={canWrite}
              findings={findings}
            />
          ) : (
            <div className="h-[520px] bg-white border-2 border-dashed border-slate-200 rounded-xl flex flex-col items-center justify-center p-8 text-center">
              <Upload className="w-10 h-10 text-slate-400 mb-3" />
              <h3 className="text-sm font-bold text-slate-900">No plan uploaded</h3>
              <p className="text-xs text-slate-500 max-w-sm mt-1 mb-4">
                Upload your construction drawing set (PDF) to start taking off quantities.
              </p>
              <label className="px-4 py-2 bg-brand-500 text-white rounded-md font-semibold text-xs cursor-pointer hover:bg-brand-700 transition">
                <span>Add PDF files</span>
                <input
                  type="file"
                  accept=".pdf,application/pdf"
                  multiple
                  onChange={handleFileUpload}
                  className="hidden"
                  disabled={!canWrite || isUploading || isStartingAi || isPaying || !workspaceId || !project.remoteId}
                />
              </label>
            </div>
          )}
        </div>

        {/* Right 1 Col: Plan Details and Actions Panel */}
        <div className="space-y-6">
          {/* Plan Details Box */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs">
            <h3 className="text-xs font-bold text-slate-900 mb-4 uppercase tracking-wider">
              Plan Details
            </h3>

            <div className="space-y-3 text-xs">
              <div className="flex justify-between items-center py-1 border-b border-slate-100">
                <span className="text-slate-500">File Name</span>
                {editingFileName ? (
                  <div className="flex items-center gap-1">
                    <input
                      type="text"
                      value={newFileName}
                      onChange={(e) => setNewFileName(e.target.value)}
                      className="border border-slate-200 rounded px-1.5 py-0.5 text-xs w-36 font-semibold"
                      autoFocus
                    />
                    <button
                      onClick={handleSaveRename} disabled={!canWrite}
                      className="px-2 py-0.5 bg-brand-500 text-white rounded text-[10px] font-bold"
                    >
                      Save
                    </button>
                  </div>
                ) : (
                  <span className="font-semibold text-slate-900 truncate max-w-[170px]" title={currentRevision?.fileName}>
                    {currentRevision?.fileName || "None"}
                  </span>
                )}
              </div>

              <div className="flex justify-between items-center py-1 border-b border-slate-100">
                <span className="text-slate-500">Revision</span>
                <span className="font-semibold text-slate-900 flex items-center gap-1">
                  <span>{currentRevision?.revisionNumber || "01"}</span>
                  <span className="w-2 h-2 rounded-full bg-brand-500 inline-block" title="Current Active Revision" />
                </span>
              </div>

              <div className="flex justify-between items-center py-1 border-b border-slate-100">
                <span className="text-slate-500">Upload Date</span>
                <span className="font-semibold text-slate-900">
                  {currentRevision?.uploadDate || "N/A"}
                </span>
              </div>

              <div className="flex justify-between items-center py-1 border-b border-slate-100">
                <span className="text-slate-500">Uploaded By</span>
                <span className="font-semibold text-slate-900">
                  {currentRevision?.uploadedBy || "—"}
                </span>
              </div>

              <div className="flex justify-between items-center py-1 border-b border-slate-100">
                <span className="text-slate-500">Pages</span>
                <span className="font-semibold text-slate-900">
                  {currentRevision?.pages || "See PDF viewer"}
                </span>
              </div>

              <div className="flex justify-between items-center py-1">
                <span className="text-slate-500">File Size</span>
                <span className="font-semibold text-slate-900">
                  {currentRevision?.fileSize || "0 MB"}
                </span>
              </div>

              <div className="flex justify-between items-center py-1 border-t border-slate-100">
                <span className="text-slate-500">Processing</span>
                <span className="font-semibold text-slate-900 capitalize">
                  {currentRevision?.processingStatus?.replace("_", " ") || (project.remoteId ? "not uploaded" : "local only")}
                </span>
              </div>
            </div>
          </div>

          {/* Actions Box */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs space-y-2">
            <h3 className="text-xs font-bold text-slate-900 mb-3 uppercase tracking-wider">
              Actions
            </h3>
            {(!fullTakeoffPurchaseAvailable || freeReadingAvailable || fullTakeoffV2Available || pilotActive || readingQuote) && <details className="space-y-2 text-xs"><summary className="cursor-pointer font-semibold">Optional reading settings</summary>
            {(!fullTakeoffPurchaseAvailable || freeReadingAvailable || fullTakeoffV2Available || pilotActive || readingQuote) && <fieldset disabled={!canWrite || !entitlementReady || (paidReading && !quoteRecoveryReady) || isStartingAi || isPaying || isUploading} className="pb-3 border-b border-slate-200">
              <legend className="text-xs font-semibold mb-2">Analysis scope</legend>
              <div className="grid grid-cols-2 gap-2">{PLAN_TRADES.map(trade => <label key={trade} className="text-xs flex items-center gap-2"><input type="checkbox" checked={selectedTrades.includes(trade)} onChange={e => { setSelectedTrades(previous => e.target.checked ? [...previous, trade] : previous.filter(value => value !== trade)); setReadingQuote(null); }} />{trade}</label>)}</div>
              {fullTakeoffV2Available && !pilotActive && <label className="flex items-start gap-2 mt-3 text-xs text-slate-700">
                <input type="checkbox" checked={fullTakeoffV2} onChange={event => setFullTakeoffV2(event.target.checked)} />
                <span>Read every page and save results for review.</span>
              </label>}
            </fieldset>}

            {fullTakeoffV2 && fullApprovalProfile && <fieldset disabled={isStartingAi || isUploading || !canWrite} className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs">
              <legend className="font-semibold">Approve provider spending for this reading</legend>
              <p>Choose a USD ceiling for each provider. These are spending limits, not a quote or a verified account balance. The reading may stop before finishing when a limit is reached.</p>
              {fullApprovalProfile.providers.map(provider => <label className="block space-y-1" key={provider.provider}>
                <span className="block font-medium">{provider.provider} · {provider.models.join(', ')}</span>
                <span className="block">Allowed limit: ${provider.minimumUsd}–${provider.maximumUsd} USD; up to {provider.maximumCalls} calls.</span>
                <input aria-label={`${provider.provider} spending limit USD`} type="number" min={provider.minimumUsd} max={provider.maximumUsd} step="0.000001" inputMode="decimal" value={fullBudgetAmounts[provider.provider] ?? ''}
                  onChange={event => { setFullBudgetAmounts(previous => ({ ...previous, [provider.provider]: event.target.value })); setFullSpendConfirmed(false); }} className="w-full rounded border border-slate-300 bg-white p-2" />
              </label>)}
              <p>Selected maximum total: {fullTakeoffSpendInput(fullApprovalProfile, fullBudgetAmounts, true) ? `$${fullApprovalProfile.providers.reduce((sum, provider) => sum + Number(fullBudgetAmounts[provider.provider] || 0), 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USD` : 'enter all limits'}. Cancellation stops new work; completed or uncertain provider requests can still cost money.</p>
              <label className="flex items-start gap-2"><input type="checkbox" checked={fullSpendConfirmed && fullSpendContext === fileContextKey} onChange={event => { setFullSpendConfirmed(event.target.checked); setFullSpendContext(fileContextKey); }} /><span>I authorize sending this PDF to the listed providers and spending up to the limits above for this reading. No automatic fallback to another provider is authorized.</span></label>
            </fieldset>}

            </details>}
            {/* Upload New Revision */}
            <label className="w-full flex items-center justify-between px-3 py-2 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg text-xs font-medium text-slate-900 transition cursor-pointer">
              <div className="flex items-center gap-2">
                <Upload className="w-3.5 h-3.5 text-brand-500" />
                <span>Add PDF files</span>
              </div>
              <span className="text-[10px] font-mono text-slate-500">
                {isUploading ? "Uploading..." : `Rev ${String(project.revisions.length + 1).padStart(2, "0")}`}
              </span>
              <input
                type="file"
                accept=".pdf,application/pdf"
                multiple
                onChange={handleFileUpload}
                className="hidden"
                disabled={!canWrite || isUploading || isStartingAi || isPaying || !workspaceId || !project.remoteId}
              />
            </label>

            {!entitlementReady && workspaceId && project.remoteId && <p role="status" className="text-xs text-slate-600">{entitlementError ? <button onClick={() => setEntitlementRetry(value => value + 1)}>Access could not be verified. Check again.</button> : 'Checking analysis access…'}</p>}
            {entitlementReady && (freeReadingAvailable || fullTakeoffV2Available) && (
              <button
                onClick={handleStartFreeReading}
                disabled={!canWrite || (!freeReadingAvailable && !fullTakeoffV2) || (fullTakeoffV2 && !fullSpendApproval) || (!fullTakeoffV2 && !selectedTrades.length) || !currentRevision?.remoteFileId || (fullTakeoffV2 ? currentRevision.processingStatus !== "ready" : ["uploading", "failed"].includes(currentRevision.processingStatus ?? "")) || isStartingAi || isPaying || isUploading}
                className="w-full flex items-center justify-between px-3 py-2 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg text-xs font-medium text-emerald-800 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <div className="flex items-center gap-2">
                  <Sparkles className="w-3.5 h-3.5 text-emerald-700" />
                  <span>{isStartingAi ? 'Starting reading…' : fullTakeoffV2 ? 'Read every page' : pilotActive ? 'Run included pilot analysis' : 'Run AI analysis (owner workspace)'}</span>
                </div>
                <span className="text-[10px] font-mono text-emerald-700">{fullTakeoffV2 ? 'provider spend tracked' : 'no charge'}</span>
              </button>
            )}

            {paidReading && !fullTakeoffPurchaseAvailable && !readingQuote && <button
              onClick={handleStartAiReading}
              disabled={!canWrite || !quoteRecoveryReady || !selectedTrades.length || !aiReadingAvailable || !currentRevision?.remoteFileId || ["uploading", "failed"].includes(currentRevision.processingStatus ?? "") || isStartingAi || isPaying || isUploading}
              className="w-full flex items-center justify-between px-3 py-2 bg-brand-50 hover:bg-blue-100 border border-blue-200 rounded-lg text-xs font-medium text-brand-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-brand-500" />
                <span>Calculate project price</span>
              </div>
              <span className="text-[10px] font-mono text-brand-500">
                {isStartingAi ? "Processing..." : currentRevision?.aiPlanStatus || ""}
              </span>
            </button>}

            {pilotActive && <p className="text-xs text-slate-600">Your pilot includes one AI attempt per project, with one PDF up to 10 MB and 10 pages. Analysis is available in your invited workspace while budget remains.</p>}

            {entitlementReady && (!aiReadingAvailable || !billingAvailable) && !freeReadingAvailable && !fullTakeoffPurchaseAvailable && <p className="text-xs leading-relaxed text-amber-800 px-1 py-2">Paid plan analysis is not available yet. Your uploaded plans and manual review remain accessible.</p>}

            {needsAiConsent && (
              <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-[11px] text-amber-900 space-y-1.5">
                <p>Sending plans to AI for reading requires this workspace's owner to approve it once.</p>
                <button
                  onClick={handleGrantAiConsent}
                  disabled={!canWrite || isGrantingAiConsent}
                  className="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded text-[11px] font-semibold transition disabled:opacity-50"
                >
                  {isGrantingAiConsent ? "Approving..." : "Approve AI plan reading"}
                </button>
              </div>
            )}

            {/* View Revisions */}
            <button
              onClick={() => setShowRevisionsModal(true)}
              disabled={project.revisions.length === 0}
              className="w-full flex items-center justify-between px-3 py-2 hover:bg-slate-50 rounded-lg text-xs font-medium text-slate-600 transition"
            >
              <div className="flex items-center gap-2">
                <History className="w-3.5 h-3.5 text-slate-500" />
                <span>View Revisions</span>
              </div>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 font-bold">
                {project.revisions.length}
              </span>
            </button>

            {/* Rename File */}
            <button
              onClick={() => {
                if (!canWrite || !currentRevision) return;
                setNewFileName(currentRevision?.fileName || "");
                setEditingFileName(true);
              }}
              disabled={!canWrite || !currentRevision}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-slate-50 rounded-lg text-xs font-medium text-slate-600 transition text-left"
            >
              <Edit2 className="w-3.5 h-3.5 text-slate-500" />
              <span>Rename File</span>
            </button>

            {/* Download Original */}
            <button
              onClick={handleDownloadOriginal}
              disabled={!currentRevision}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-slate-50 rounded-lg text-xs font-medium text-slate-600 transition text-left"
            >
              <Download className="w-3.5 h-3.5 text-slate-500" />
              <span>Download Original</span>
            </button>

            {/* Delete Plan */}
            <button
              onClick={handleDeletePlan}
              disabled={!canWrite || !currentRevision || isUploading || isStartingAi || isPaying}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-rose-50 text-rose-600 rounded-lg text-xs font-medium transition text-left"
            >
              <Trash2 className="w-3.5 h-3.5 text-rose-500" />
              <span>Delete Plan</span>
            </button>
          </div>
        </div>
      </div>

      </details>
      <div id="project-photos"><PhotoTakeoffPanel key={`${workspaceId}:${project.remoteId}`} ref={photoPanel} uploadRequest={photoUploadRequest} onIntakeState={setPhotoIntakeState} workspaceId={workspaceId} projectId={project.remoteId} canWrite={canWrite} /></div>

      {workspaceId && project.remoteId && <ConstructionBudgetPanel key={`budget:${workspaceId}:${project.remoteId}`} workspaceId={workspaceId} projectId={project.remoteId} canWrite={canWrite} />}

      {/* Bottom Next Step Button */}
      <div className="flex justify-end pt-4 border-t border-slate-200">
        <button
          onClick={onContinue}
          className="flex items-center gap-2 px-5 py-2.5 bg-brand-500 hover:bg-brand-700 text-white rounded-md text-xs font-semibold transition shadow-xs cursor-pointer"
        >
          <span>Continue to Quantities</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Revision History Modal */}
      {showRevisionsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-2xs p-4 select-none">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-lg p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <History className="w-4 h-4 text-brand-500" />
                <span>Plan Revision History</span>
              </h3>
              <button
                onClick={() => setShowRevisionsModal(false)}
                className="text-slate-400 hover:text-slate-900"
              >
                ✕
              </button>
            </div>

            <div className="space-y-2.5">
              {project.revisions.map((rev) => (
                <div
                  key={rev.id}
                  className={`p-3.5 rounded-lg border flex items-center justify-between transition ${
                    rev.isCurrent
                      ? "bg-brand-50 border-blue-200"
                      : "bg-white border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-xs text-slate-900">
                        Revision {rev.revisionNumber}
                      </span>
                      {rev.isCurrent && (
                        <span className="text-[10px] font-bold bg-brand-500 text-white px-2 py-0.5 rounded">
                          CURRENT
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {rev.fileName} • {rev.uploadDate} ({rev.fileSize})
                    </div>
                    {rev.notes && (
                      <p className="text-[11px] text-slate-500 italic mt-1">
                        &quot;{rev.notes}&quot;
                      </p>
                    )}
                  </div>

                  {!rev.isCurrent && (
                    <button
                      onClick={() => handleSetCurrentRevision(rev.id)} disabled={!canWrite}
                      className="px-3 py-1.5 border border-slate-200 rounded text-xs font-medium text-slate-600 hover:bg-slate-100"
                    >
                      Make Current
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="pt-2 flex justify-end">
              <button
                onClick={() => setShowRevisionsModal(false)}
                className="px-4 py-2 bg-slate-900 text-white rounded-md text-xs font-semibold"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
