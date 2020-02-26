"use strict";


import {button, Content, div, span, tag, TagElement, textarea, textbox} from "../util/tags";
import {
    CreateComment,
    CurrentIdentity, DeleteComment, UIMessageListener,
    UIMessageRequest,
    UIMessageTarget, UpdateComment
} from "../util/ui_event";
import * as uuidv4 from 'uuid/v4';
import {CellComment} from "../../data/data";
import {PosRange} from "../../data/result";
import {Cell, CodeCell} from "./cell";
import * as monaco from "monaco-editor";
import {editor, IDisposable, IRange} from "monaco-editor";
import IStandaloneCodeEditor = editor.IStandaloneCodeEditor;
import IModelContentChangedEvent = editor.IModelContentChangedEvent;
import TrackedRangeStickiness = editor.TrackedRangeStickiness;

export type CommentID = string

// to ensure UUID uniqueness, make sure to only create new comments with createCellComment!
export function createCellComment({range, author, createdAt, content}: Omit<CellComment, 'uuid'>): CellComment {
    const uuid = uuidv4();
    return new CellComment(
        uuid,
        range,
        author,
        createdAt,
        content,
    )
}

// Comment Handler is in charge of comments for a particular cell
export class CommentHandler extends UIMessageTarget {
    private comments: Record<CommentID, CellComment> = {}; // holds all comments (root and replies)
    private commentUIs: Record<string, CommentUI> = {};    // lookup table for comment UIs (keys are ranges, serialized as strings)
    private commentRoots: Record<string, CommentID> = {};  // lookup table for range (serialized as string) to root comments
    private highlights: Record<string, string[]> = {};     // deltaDecorations, range string -> monaco decoration ids.

    constructor(readonly cellId: number, readonly editor: IStandaloneCodeEditor) {
        super();

        this.subscribe(CreateComment, (cellId, comment) => {
            this._add(comment);
        });
        this.subscribe(UpdateComment, (cellId, commentId, range, content) => {
            this._update(commentId, range, content);
        });
        this.subscribe(DeleteComment, (cellId, commentId) => {
            this._delete(commentId);
        });

        this.editor.onDidChangeModelContent((evt: IModelContentChangedEvent) => {
            const model = this.editor.getModel();
            if (model) {
                // check for drift between decorations and the ranges we're keeping
                const modelDecorations = model.getAllDecorations();
                Object.entries(this.highlights).forEach(([range_str, highlights]) => {
                    const maybeDecoration = modelDecorations.find(d => highlights.includes(d.id));
                    if (maybeDecoration && !maybeDecoration.range.isEmpty()) {
                        const ps = PosRange.fromString(range_str);
                        const startPos = model.getPositionAt(ps.start);
                        const endPos = model.getPositionAt(ps.end);
                        const mRange = monaco.Range.fromPositions(startPos, endPos);
                        if (!monaco.Range.equalsRange(maybeDecoration.range, mRange)) {
                            // we have a highlight with the same ID, but a different range. This means there is some drift.
                            const newRange = new PosRange(model.getOffsetAt(maybeDecoration.range.getStartPosition()), model.getOffsetAt(maybeDecoration.range.getEndPosition()));
                            const rootId = this.commentRoots[range_str];
                            const root = this.comments[rootId];

                            // console.log("Updated range for", rootId, "from", ps, "to", newRange, root);
                            this.publish(new UpdateComment(this.cellId, rootId, newRange, root.content));

                            // reset highlights.
                            delete this.highlights[range_str];
                            this.highlights[newRange.asString] = highlights;
                        }
                    } else {
                        // decoration wasn't found or was empty, so we need to delete it.
                        const rootAtRange = this.commentRoots[range_str];
                        if (rootAtRange) {
                            // console.log("deleting comment", rootAtRange, "at range", range_str);
                            this.publish(new DeleteComment(this.cellId, rootAtRange));
                        }
                        delete this.highlights[range_str];

                        // if the range was empty, remove it.
                        if (maybeDecoration) model.deltaDecorations([maybeDecoration.id], [])
                    }
                });
            }
        })
    }

    // placeholder for avatars
    private static fetchAvatar(author: string) {
        return undefined;
    }

    private _add(comment: CellComment) {
        this.comments[comment.uuid] = comment;
        const maybeRootId = this.commentRoots[comment.range.asString];
        if (maybeRootId === undefined || this.comments[maybeRootId].createdAt > comment.createdAt) {
            this.commentRoots[comment.range.asString] = comment.uuid;
        }
    }

    add(comment: CellComment) {
        this._add(comment);
        if (!this.commentUIs[comment.range.asString]) {
            this.commentUIs[comment.range.asString] = this.initializeUI(comment.range);
        }

        this.commentUIs[comment.range.asString].add(comment);
    }

    private _update(commentId: CommentID, range: PosRange, content: string) {
        const prev = this.comments[commentId];
        const upd = new CellComment(prev.uuid, range, prev.author, prev.createdAt, content);

        // we need to update some things if the range has been changed and this is a root comment.
        if (range !== prev.range && this.commentRoots[prev.range.asString] === commentId) {
            // of course, we need to reset the comment root
            delete this.commentRoots[prev.range.asString];
            this.commentRoots[range.asString] = commentId;

            // next, update the comment UIs
            const ui = this.commentUIs[prev.range.asString];
            delete this.commentUIs[prev.range.asString];
            this.commentUIs[range.asString] = ui;
            ui.range = range;

            // finally, update all the other comments.
            Object.values(this.comments).filter(c => c !== prev).forEach(c => {
                if (c.range.equals(prev.range)) {
                    this.publish(new UpdateComment(this.cellId, c.uuid, range, c.content));
                    // console.log("Updating comment", c.uuid, "from", c.range, "to", range, "because its root comment was updated")
                }
            });
        }
        this.comments[commentId] = upd;
        return upd;
    }

    update(commentId: CommentID, range: PosRange, content: string) {
        const upd = this._update(commentId, range, content);
        this.commentUIs[upd.range.asString].update(upd);
    }



    private _delete(commentId: CommentID) {
        const comment = this.comments[commentId];
        delete this.comments[commentId];

        if (this.commentRoots[comment.range.asString] === commentId) {
            // if this is a root comment, we need to delete all the comments for this range
            Object.values(this.comments).forEach(c => {
                if (c.range.equals(comment.range)) {
                    this._delete(c.uuid);

                }
            });
            delete this.commentRoots[comment.range.asString];
            this.hide(comment.range);
        }

        return comment.range;
    }

    delete(commentId: CommentID) {
        const range = this._delete(commentId);
        const maybeUI = this.commentUIs[range.asString];
        if (maybeUI) maybeUI.delete(commentId);
    }

    private initializeUI(range: PosRange, name?: string, avatar?: string) {
        const commentUI = new CommentUI(this.cellId, this.editor, range,  name, avatar).setParent(this);
        this.commentUIs[range.asString] = commentUI;
        this.rangeHighlight(range);
        return commentUI;
    }

    show(range: PosRange) {
        if (!this.commentUIs[range.asString]) {
            this.publish(new UIMessageRequest(CurrentIdentity, (name, avatar) => {
                this.initializeUI(range, name, avatar).focus();
            }));
        } else {
            this.commentUIs[range.asString].show();
            this.rangeHighlight(range);
        }
    }

    hide(range: PosRange) {
        const found = this.commentUIs[range.asString];
        if (found) {
            found.hide();
            this.rangeHighlight(range);
            // if there are no comments for this range, we should remove this UI
            if (this.commentRoots[found.range.asString] === undefined ){
                delete this.commentUIs[range.asString];
                this.editor.deltaDecorations(this.highlights[range.asString] || [], []);
                delete this.highlights[range.asString];
            }
        }
    }

    private rangeHighlight(range: PosRange) {
        const model = this.editor.getModel();
        if (model) {
            const startPos = model.getPositionAt(range.start);
            const endPos = model.getPositionAt(range.end);
            const mRange = monaco.Range.fromPositions(startPos, endPos);

            const currentPosition = this.editor.getPosition();
            let className = 'comment-highlight';
            if (currentPosition && mRange.containsPosition(currentPosition)) {
                className = 'comment-highlight-strong';
            }
            this.highlights[range.asString] = this.editor.deltaDecorations(this.highlights[range.asString] || [], [
                {
                    range: mRange,
                    options: {
                        className: className,
                        stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
                        hoverMessage: { value: 'Click to see comment'}
                    },
                }
            ]);
        }
    }

    handleSelection(selection: monaco.Selection) {
        const model = this.editor.getModel();
        if (model) {
            // check if there is a comment there
            let found = false;
            Object.keys(this.commentUIs).forEach(range_str => {
                const ps = PosRange.fromString(range_str);
                const startPos = model.getPositionAt(ps.start);
                const endPos = model.getPositionAt(ps.end);
                const mRange = monaco.Range.fromPositions(startPos, endPos);
                if (mRange.containsRange(selection)) {
                    this.show(ps);
                    found = true;
                } else {
                    this.hide(ps);
                }
            });

            // otherwise, show the new comment button
            if (!found) {
                if (!selection.isEmpty()) {
                    const range = new PosRange(model.getOffsetAt(selection.getStartPosition()), model.getOffsetAt(selection.getEndPosition()));
                    if (range.start != range.end) {
                        new CommentButton(this.editor, range, () => {
                            this.show(range);
                        }).show()
                    } else {
                        this.hide(range);
                    }
                }
            }
        }
    }
}

// An overlay element that "sticks" to some position relative to a range in a Monaco cell
abstract class MonacoCellOverlay extends UIMessageTarget {
    readonly container: TagElement<"div">;
    protected readonly editorListeners: IDisposable[] = [];

    protected constructor(readonly editor: IStandaloneCodeEditor, content: Content, public range: PosRange) {
        super();

        this.container = div(['cell-overlay'], content);

        this.position();
    }

    abstract calculatePosition(): [number, number]

    private position() {
        const [x, y] = this.calculatePosition();
        this.container.style.left = `${x}px`;
        this.container.style.top = `${y}px`;
    }

    show() {
        this.hide();
        if (!this.container.parentElement) {
            document.body.appendChild(this.container);
        }

        this.editorListeners.push(this.editor.onDidLayoutChange(() => {
            this.position();
        }));
    }

    hide() {
        if (this.container.parentElement) this.container.parentElement.removeChild(this.container);
        while (this.editorListeners.length > 0) {
            const l = this.editorListeners.pop();
            if (l) l.dispose();
        }
    }
}

class RightGutterOverlay extends MonacoCellOverlay {
    calculatePosition(): [number, number] {
        const model = this.editor.getModel();
        const editorEl = this.editor.getDomNode();
        if (model && editorEl) {
            const endPos = model.getPositionAt(this.range.end);
            const containerOffset = editorEl.getBoundingClientRect().left;
            const currentY = this.editor.getTopForPosition(endPos.lineNumber, endPos.column);
            const containerY = editorEl.getBoundingClientRect().top;

            const l = this.editor.getLayoutInfo();
            const x = (
                containerOffset                 // the location of this cell on the page
                + l.contentWidth                // the width of the content area
                - l.verticalScrollbarWidth      // don't want to overlay on top of the scrollbar.
            );
            const y = containerY + currentY;
            return [x, y];
        } else {
            this.hide(); // should we throw an error instead?
            return [0, 0];
        }
    }
}

export class CommentButton extends RightGutterOverlay {

    constructor(readonly editor: IStandaloneCodeEditor, readonly range: PosRange, readonly clickCb: () => void) {
        super(editor, div(['new-comment-button'], []).click((evt) => this.onClick(evt)), range);
    }

    onClick(evt: Event) {
        evt.stopPropagation();
        evt.preventDefault();

        this.clickCb();
        this.hide();
    }

    show() {
        super.show();
        this.editorListeners.push(this.editor.onDidChangeCursorSelection(() => {
            const selection = this.editor.getSelection();
            if (selection) {
                const model = this.editor.getModel();
                if (model) {
                    const range = new PosRange(model.getOffsetAt(selection.getStartPosition()), model.getOffsetAt(selection.getEndPosition()));
                    if (range.equals(this.range)) {
                        return;
                    }
                }
            }
            this.hide(); // if we got here it means the overlay should be hidden.
        }));
    }
}

type CommentContainer = TagElement<"div"> & {uuid: string, createdAt: number, avatar?: string }

export class CommentUI extends RightGutterOverlay {
    private readonly commentsEl: TagElement<"div">;
    private readonly newComment: TagElement<"div">;
    private newCommentText: TagElement<"textarea">;
    private readonly commentContainers: CommentContainer[] = [];
    private readonly currentAuthor: string | TagElement<"input">;

    constructor(readonly cellId: number, editor: IStandaloneCodeEditor, range: PosRange, currentAuthor?: string, readonly currentAvatar?: string) {
        super(editor, undefined, range);
        const [text, controls] = this.commentSubmitter(
            () => this.doCreate(),
            () => this.hide()
        );
        this.currentAuthor = currentAuthor || textbox(['author-input'], 'Author', '');
        this.newComment = div(['create-comment', 'comment'], [
            div(['header'], [
                span(['avatar'], [currentAvatar]),
                span(['author'], [this.currentAuthor]),
            ]),
            div(["comment-content"], [
                this.newCommentText = text,
                controls
            ]),
        ]);

        this.commentsEl = div(['comments-list'], [this.newComment]);
        this.container.appendChild(this.commentsEl);
        this.container.classList.add('comment-container');
    }

    private commentSubmitter(onSubmit: () => void, onCancel: () => void, initialContent: string = ''): [TagElement<"textarea">, TagElement<"div">] {
        const text = textarea(['comment-text'], '', initialContent).listener('keydown', (evt: KeyboardEvent) => {
            if (evt.shiftKey && evt.key === "Enter") {
                onSubmit();
                evt.stopPropagation();
                evt.preventDefault();
            }
        });
        const controls = div(['controls'], [
            button(['create-comment-button'], {}, ['Comment']).click(() => onSubmit()),
            button(['cancel'], {}, ['Cancel']).click(() => onCancel())
        ]);
        return [text, controls];
    }

    focus() {
        this.show();
        this.newCommentText.focus();
    }

    private doCreate() {
        if (this.newCommentText.value) {
            const comment = createCellComment({
                range: this.range,
                author: typeof(this.currentAuthor) === "string" ? this.currentAuthor : this.currentAuthor.value,
                createdAt: Date.now(),
                content: this.newCommentText.value,
            });
            this.add(comment);
            this.newCommentText.value = "";
            this.publish(new CreateComment(this.cellId, comment));
        }
    }

    private doEdit(comment: CellComment) {
        const container = this.commentContainers.find(c => c.uuid === comment.uuid)!;
        const oldContent = container.querySelector(".comment-content") as TagElement<"div">;
        const [text, controls] = this.commentSubmitter(() => {
            const newComment: CellComment = {
                ...comment,
                content: text.value
            };
            this.update(newComment);
            this.publish(new UpdateComment(this.cellId, newComment.uuid, newComment.range, newComment.content))
        }, () => {
            container.replaceChild(oldContent, newEl)
        }, oldContent.innerText);
        const newEl = div(['comment-content'], [text, controls]);
        container.replaceChild(newEl, oldContent);
    }

    private doDelete(commentId: string) {
        this.delete(commentId);
        this.publish(new DeleteComment(this.cellId, commentId))
    }

    private commentElement(comment: CellComment, avatar?: string): CommentContainer {
        const actions = div(['actions'], []);

        if (typeof(this.currentAuthor) === "string" ? comment.author === this.currentAuthor : true) {
            actions.click(() => {
                console.log("showing menu")
                const listener = () => {
                    console.log("removing menu")
                    actions.removeChild(items);
                    document.body.removeEventListener("mousedown", listener);
                };
                const items = tag('ul', [], {}, [
                    tag('li', [], {}, ['Edit']).click((e) => { e.preventDefault(); e.stopPropagation(); listener(); this.doEdit(comment) }),
                    tag('li', [], {}, ['Delete']).click(() => { listener(); this.doDelete(comment.uuid) }),
                ]).listener("mousedown", evt => evt.stopPropagation());

                document.body.addEventListener("mousedown", listener);
                actions.appendChild(items);
            })
        } else {
            actions.disable()
        }

        return Object.assign(div(['comment'], [
            div(['header'], [
                span(['avatar'], [avatar]),
                div(['author-timestamp'], [
                    span(['author'], [comment.author]),
                    span(['timestamp'], [new Date(Number(comment.createdAt)).toLocaleString("en-US", {timeZoneName: "short"})]),
                ]),
                actions
            ]),
            div(['comment-content'], [comment.content])
        ]), {
            uuid: comment.uuid,
            createdAt: comment.createdAt,
            avatar: avatar
        });
    }

    add(comment: CellComment, avatar?: string) { // TODO: avatars
        const container = this.commentElement(comment, avatar);

        let next: {c: CommentContainer, idx: number} | undefined;
        // we can assume commentContainers is ordered by creation time because we build it here
        for (const [idx, c] of this.commentContainers.entries()) {
            if (c.createdAt > comment.createdAt) {
                next = {c, idx};
                break;
            }
        }

        if (next) {
            this.commentContainers.splice(next.idx, 0, container);
            this.commentsEl.insertBefore(container, next.c);
        } else {
            this.commentContainers.push(container);
            this.commentsEl.insertBefore(container, this.newComment);
        }
    }

    update(updated: CellComment) {
        const containerIdx = this.commentContainers.findIndex(c => c.uuid === updated.uuid)!;
        const container = this.commentContainers[containerIdx];
        const newEl = this.commentElement(updated, container.avatar);
        container.parentElement!.replaceChild(newEl, container);
        this.commentContainers[containerIdx] = newEl;
    }

    delete(id: string) {
        const containerIdx = this.commentContainers.findIndex(c => c.uuid === id)!;
        const container = this.commentContainers[containerIdx];
        this.commentsEl.removeChild(container);
        this.commentContainers.splice(containerIdx, 1);
    }
}
