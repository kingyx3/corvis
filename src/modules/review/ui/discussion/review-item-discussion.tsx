"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  MAX_REVIEW_COMMENT_LENGTH,
  REVIEW_SUBJECT_KIND_LABEL,
  appendMention,
  assigneeLabel,
  commentSegments,
  mentionedUserIds,
  type ReviewSubjectRef,
  type ReviewThread,
  type ReviewThreadSummary,
} from "@/modules/review/domain/review-discussion";
import { Icon } from "@/shared/ui/icon";
import { Modal } from "@/shared/ui/modal";
import { assignReviewItem, commentOnReviewItem, getReviewThread, reviewDiscussionErrorMessage } from "@/modules/review/ui/discussion/api";
import { displayDate } from "@/shared/lib/display-format";

const UNASSIGNED = "";

/**
 * Assign and discuss one review item (F3). The assignee can be changed or cleared and the discussion is a thread of
 * append-only comments that may @mention teammates who have review access. The dialog says plainly that none of this
 * decides anything: approving, rejecting, correcting and resolving stay with the review actions, and a comment never counts
 * toward dual control. Comment text is shown as text only, never as markup.
 */
export function ReviewItemDialog({ subject, itemLabel, onClose, onChanged }: {
  subject: ReviewSubjectRef;
  itemLabel: string;
  onClose: () => void;
  onChanged: (summary: ReviewThreadSummary) => void;
}) {
  const [thread, setThread] = useState<ReviewThread | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [assignee, setAssignee] = useState(UNASSIGNED);
  const [savingAssignee, setSavingAssignee] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [assignNotice, setAssignNotice] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  // One key per distinct comment text: a retry after a network failure can never record it twice, and an edited text is a new comment.
  const commentKey = useRef<{ key: string; body: string } | null>(null);
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const assigneeId = useId();
  const commentId = useId();
  const hintId = useId();

  useEffect(() => {
    const controller = new AbortController();
    void getReviewThread(subject, controller.signal).then((loaded) => {
      if (controller.signal.aborted) return;
      setThread(loaded);
      setAssignee(loaded.assignee?.userId ?? UNASSIGNED);
      setLoadError(null);
    }).catch((reason) => {
      if (!controller.signal.aborted) setLoadError(reviewDiscussionErrorMessage(reason, "The discussion could not be loaded."));
    });
    return () => controller.abort();
  }, [subject.subjectKind, subject.subjectId, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps -- the ref is identified by its two fields

  const trimmed = text.trim();
  const currentAssignee = thread?.assignee?.userId ?? UNASSIGNED;
  const eligible = thread?.members ?? [];

  const saveAssignment = async (event: FormEvent) => {
    event.preventDefault();
    if (!thread || savingAssignee || assignee === currentAssignee) return;
    setSavingAssignee(true);
    setAssignError(null);
    setAssignNotice(null);
    try {
      const summary = await assignReviewItem(subject, { assigneeUserId: assignee === UNASSIGNED ? null : assignee, expectedVersion: thread.version });
      setThread((current) => current && { ...current, ...summary });
      onChanged(summary);
      setAssignNotice(summary.assignee ? (summary.assignee.isMe ? "Assigned to you." : `Assigned to ${summary.assignee.displayName}.`) : "Assignment cleared.");
    } catch (reason) {
      setAssignError(reviewDiscussionErrorMessage(reason, "The assignment could not be saved. Nothing was changed; try again."));
      // A stale assignment is answered with the latest one, so reload it rather than leave the person guessing.
      if ((reason as { code?: unknown } | null)?.code === "assignment_changed") setReloadKey((key) => key + 1);
    } finally {
      setSavingAssignee(false);
    }
  };

  const postComment = async (event: FormEvent) => {
    event.preventDefault();
    if (!thread || !trimmed || posting) return;
    if (commentKey.current?.body !== trimmed) commentKey.current = { key: crypto.randomUUID(), body: trimmed };
    setPosting(true);
    setCommentError(null);
    try {
      const { comment, thread: summary } = await commentOnReviewItem(subject, { idempotencyKey: commentKey.current.key, body: trimmed, mentionUserIds: mentionedUserIds(trimmed, thread.members) });
      setThread((current) => current && { ...current, ...summary, comments: current.comments.some((entry) => entry.commentId === comment.commentId) ? current.comments : [...current.comments, comment] });
      onChanged(summary);
      setText("");
      commentKey.current = null;
    } catch (reason) {
      setCommentError(reviewDiscussionErrorMessage(reason, "The comment could not be posted. Nothing was recorded; try again."));
    } finally {
      setPosting(false);
    }
  };

  const mention = (userId: string) => {
    const member = eligible.find((candidate) => candidate.userId === userId);
    if (!member) return;
    setText((current) => appendMention(current, member));
    composer.current?.focus();
  };

  return <Modal label={`Assign and discuss: ${itemLabel}`} onClose={onClose} width="min(680px, 100%)">
    <div className="dialog-body review-discussion-dialog">
      <div className="review-discussion-heading">
        <div><p className="eyebrow">{REVIEW_SUBJECT_KIND_LABEL[subject.subjectKind]}</p><h2>Assign and discuss</h2><p className="review-discussion-item">{itemLabel}</p></div>
        <button type="button" className="secondary-button" onClick={onClose}>Close</button>
      </div>
      <div className="lineage-note" role="note"><Icon name="shield"/><div><strong>Discussion does not decide anything</strong><span>Approve, reject, correct and resolve stay with the review actions. Assigning and commenting never change the value, never count toward dual control and are recorded in the audit trail.</span></div></div>
      {loadError && <div className="lineage-note tone-danger" role="alert"><Icon name="alert"/><div><strong>Discussion unavailable</strong><span>{loadError}</span></div><button type="button" className="text-button" onClick={() => setReloadKey((key) => key + 1)}>Retry</button></div>}
      {!thread && !loadError && <p role="status" className="empty-cell">Loading discussion…</p>}
      {thread && <>
        <form className="review-assign-form" onSubmit={(event) => void saveAssignment(event)}>
          <label className="form-field" htmlFor={assigneeId}>
            <span>Assignee</span>
            <select id={assigneeId} className="filter-button" value={assignee} disabled={savingAssignee} onChange={(event) => { setAssignee(event.target.value); setAssignNotice(null); }}>
              <option value={UNASSIGNED}>Unassigned</option>
              {thread.assignee && !eligible.some((member) => member.userId === thread.assignee!.userId) && <option value={thread.assignee.userId}>{thread.assignee.displayName} (no longer has review access)</option>}
              {eligible.map((member) => <option key={member.userId} value={member.userId}>{member.displayName}{member.isMe ? " (you)" : ""} · {member.roleLabel}</option>)}
            </select>
            <small className="field-hint">Only workspace members with review access to this item can be assigned. {assigneeLabel(thread.assignee)}.</small>
          </label>
          <button type="submit" className="secondary-button" disabled={savingAssignee || assignee === currentAssignee}>{savingAssignee ? "Saving…" : "Save assignment"}</button>
        </form>
        {assignNotice && <div className="lineage-note tone-success" role="status"><Icon name="check"/><div><strong>{assignNotice}</strong></div></div>}
        {assignError && <div className="lineage-note tone-danger" role="alert"><Icon name="alert"/><div><strong>Assignment not saved</strong><span>{assignError}</span></div></div>}

        <section aria-labelledby={`${commentId}-heading`}>
          <h3 id={`${commentId}-heading`} className="review-discussion-subheading">Discussion · {thread.comments.length} {thread.comments.length === 1 ? "comment" : "comments"}</h3>
          {thread.comments.length === 0
            ? <p className="field-hint">No comments yet. Start the conversation below; mention a teammate with @ to notify them.</p>
            : <ol className="review-comments" aria-label="Comments, oldest first">
              {thread.comments.map((comment) => <li key={comment.commentId} className="review-comment">
                <div className="review-comment-head"><strong>{comment.author.displayName}{comment.author.isMe ? " (you)" : ""}</strong><time dateTime={comment.createdAt}>{displayDate(comment.createdAt, { timeStyle: "short" })}</time></div>
                <p className="review-comment-body">{commentSegments(comment.body, comment.mentions.map((person) => person.displayName)).map((segment, index) => segment.mention ? <strong key={index} className="review-mention">{segment.text}</strong> : <span key={index}>{segment.text}</span>)}</p>
              </li>)}
            </ol>}
        </section>

        <form className="review-comment-form" onSubmit={(event) => void postComment(event)}>
          <label className="form-field" htmlFor={commentId}>
            <span>Add a comment</span>
            <textarea id={commentId} ref={composer} className="input-control" rows={4} maxLength={MAX_REVIEW_COMMENT_LENGTH} value={text} disabled={posting} aria-describedby={hintId}
              placeholder="Say what you found or what you need. Use @ and a teammate's name to notify them." onChange={(event) => setText(event.target.value)}/>
          </label>
          <small id={hintId} className="field-hint">{trimmed.length.toLocaleString()} / {MAX_REVIEW_COMMENT_LENGTH.toLocaleString()}. Comments cannot be edited or deleted. Teammates you mention are told they were mentioned, never what you wrote.</small>
          {eligible.some((member) => !member.isMe) && <label className="form-field review-mention-picker">
            <span>Mention a teammate</span>
            <select className="filter-button" value="" disabled={posting} onChange={(event) => mention(event.target.value)}>
              <option value="">Choose a teammate to mention…</option>
              {eligible.filter((member) => !member.isMe).map((member) => <option key={member.userId} value={member.userId}>{member.displayName} · {member.roleLabel}</option>)}
            </select>
          </label>}
          {commentError && <div className="lineage-note tone-danger" role="alert"><Icon name="alert"/><div><strong>Comment not posted</strong><span>{commentError}</span></div></div>}
          <div className="dialog-actions"><button type="submit" className="primary-button" disabled={posting || !trimmed}>{posting ? "Posting…" : "Post comment"}</button></div>
        </form>
      </>}
    </div>
  </Modal>;
}

/** What the dialog is opened on: the item and a label a person recognises (company and metric, or the exception summary). */
export type ReviewDiscussionTarget = { subject: ReviewSubjectRef; itemLabel: string };

/**
 * The assignee and the way into the discussion, placed in the row of a review item. It shows who holds the item ("Assigned
 * to you", "Assigned to Priya" or "Unassigned") and how much has been said, and asks the screen to open the dialog. The
 * screen owns the dialog, not the row: changing the assignee can make the row drop out of an active assignment filter, and
 * the person must still see the result of what they just did.
 */
export function ReviewItemDiscussion({ target, summary, onOpen }: {
  target: ReviewDiscussionTarget;
  summary?: ReviewThreadSummary;
  onOpen: (target: ReviewDiscussionTarget) => void;
}) {
  const count = summary?.commentCount ?? 0;
  return <div className="review-discussion">
    <span className="review-assignee" data-assigned={summary?.assignee ? (summary.assignee.isMe ? "me" : "other") : "none"}>{assigneeLabel(summary?.assignee)}</span>
    <button type="button" className="text-button" aria-haspopup="dialog" aria-label={`Assign or discuss ${target.itemLabel}${count ? `, ${count} ${count === 1 ? "comment" : "comments"}` : ""}`} onClick={() => onOpen(target)}>
      {count ? `Discuss (${count})` : "Assign or discuss"}
    </button>
  </div>;
}
