<template>
  <component
    :is="is || 'ul'"
    :class="{'dnd-list': true, 'dnd-list-empty': displayItems.length === 0}"
    ref="$top"
    @dragenter="parentDragEnter"
    @dragleave="parentDragExit"
    @dragexit="parentDragExit"
    @dragover="parentDragOver"
    @drop="doDrop"
  >
    <template v-for="(item, index) of displayItems" :key="itemKey(item)">
      <component
        v-if="index === state.droppingToIndex"
        :is="itemIs || 'li'"
        :style="ghostStyle"
        class="dnd-list-ghost dropping-here"
        :data-key="itemKey(item)"
        @dragenter="ghostDragEnter"
        @dragover="ghostDragOver($event)"
        @drop="doDrop"
      >
        <slot name="ghost" />
      </component>

      <component
        :is="itemIs || 'li'"
        :class="itemClassFor(item, index)"
        :data-key="itemKey(item)"
        ref="$dndElements"
        @mousedown.stop="enableDrag"
        @mouseup.stop="disableDrag"
        @dragstart="itemDragStart($event, index)"
        @dragend="itemDragEnd"
        @dragenter="itemDragEnter($event, index)"
        @dragover="itemDragOver($event, index)"
        @drop="doDrop"
      >
        <slot name="item" :item="item" />
      </component>
    </template>

    <component
      v-if="state.droppingToIndex === displayItems.length"
      :is="itemIs || 'li'"
      :style="ghostStyle"
      class="dnd-list-ghost dropping-here"
      @dragenter="ghostDragEnter"
      @dragover="ghostDragOver($event)"
      @drop="doDrop"
    >
      <slot name="ghost" />
    </component>
  </component>
</template>

<script lang="ts">
import {computed, nextTick, reactive, ref} from "vue";

import {trace_fn} from "../util/debug.js";
import type {DragAction, DropAction} from "./dnd-list.js";

/** Reactive object describing the shared state of a <dnd-list>. */
type ListState<I = unknown> = {
  /** The DnD items that are actually in this list. */
  readonly modelValue: readonly I[];

  /** A snapshot of the model saved before beginning an actual drop operation,
   * which is shown to the user until the drop operation completes.  This
   * buffering ensures the user doesn't see any flickering during the drop. */
  modelSnapshot: undefined | readonly I[];

  /** If dragging from this list, this is the index of the dragged item.  Must
   * be set iff this ListState is the `sourceList`. */
  draggingFromIndex: number | undefined;

  /** If dropping into this list, this is the index of the drop location. Must
   * be set iff this ListState is the `destList`. */
  droppingToIndex: number | undefined;
};

const trace = trace_fn("dnd-list");

//
// BEGIN UGLY GLOBAL STATE
//

// The source and destination lists of an in-progress drag operation (if any).
//
// NOTE: Source and destination may be the same list, and either source or
// destination may be null (the former, in particular, is possible when
// something is being dragged in from outside the app entirely).
//
// PERF: These must be non-reactive--that is, each list should only react to its
// own ListState, otherwise performans issues will result when there are many
// dnd-lists on the same page.
let sourceList: ListState | undefined = undefined;
let destList: ListState | undefined = undefined;

// An in-progress drop operation--once the user releases the mouse button, we
// start the async drop() function, and while it's running, this is set to the
// drop action.
let dropTask: DropAction | undefined = undefined;

// Reactive object that describes the width/height of the ghost, if required.
const ghostSize = ref(undefined as undefined | {width: number; height: number});
</script>

<script setup lang="ts" generic="I">
const props = defineProps<{
  is?: string;
  itemIs?: string;
  itemKey: (item: I) => string | number;
  itemClass?: (item: I, index: number) => Record<string, boolean>;
  accepts: string | readonly string[];
  modelValue: I[];

  drag: (drag: DragAction<I>) => void;
  drop: (drop: DropAction) => Promise<void>;

  /** What is the visual orientation of the list?
   *
   * If the list is actually a grid (e.g. flexbox), "vertical" and
   * `ghostDisplacesItems: true` are recommended. */
  orientation: "horizontal" | "vertical";

  /** When the ghost is displayed, does it cause items to change their positions
   * on the screen? */
  ghostDisplacesItems?: boolean;

  /** Should the ghost mimic the height of the item it's replacing? */
  ghostMimicsWidth?: boolean;

  /** Should the ghost mimic the width of the item it's replacing? */
  ghostMimicsHeight?: boolean;
}>();

const $top = ref(undefined! as HTMLElement);
const $dndElements = ref([] as HTMLElement[]);

/** State shared between dnd-list components so they can coordinate */
const state: ListState<I> = reactive({
  modelValue: computed(() => props.modelValue),
  modelSnapshot: undefined,
  draggingFromIndex: undefined,
  droppingToIndex: undefined,
});

const ghostStyle = computed((): string | undefined => {
  const s = ghostSize.value;
  if (!s) return undefined;

  let style = "";
  if (props.ghostMimicsWidth) style += `width: ${s.width}px; `;
  if (props.ghostMimicsHeight) style += `height: ${s.height}px; `;
  return style || undefined;
});

const displayItems = computed((): readonly I[] => {
  return state.modelSnapshot ?? props.modelValue;
});

function itemClassFor(item: I, index: number): Record<string, boolean> {
  const classes = props.itemClass ? props.itemClass(item, index) : {};
  classes.dragging = state.draggingFromIndex === index;
  return classes;
}

/** Given a DOM Event, locate the corresponding element in the DOM for
 * the DnD item. */
function dndElement(ev: Event): HTMLElement | undefined {
  if (!($dndElements.value instanceof Array)) return;
  let t = ev.target;
  while (t instanceof HTMLElement) {
    if ($dndElements.value.includes(t)) return t;
    t = t.parentElement;
  }
  return undefined;
}

/** We only set `draggable="true"` on the dragged element when we
 * actually want to start dragging.  This allows for children of the
 * draggable element to intercept mousedown events to prevent dragging,
 * so that such children can be interacted with. */
function enableDrag(ev: DragEvent) {
  const el = dndElement(ev);
  if (el) el.draggable = true;
}

/** Undo the effect of enableDrag() -- see that method for details. */
function disableDrag(ev: DragEvent) {
  const el = dndElement(ev);
  if (el) el.draggable = false;
}

/** Fired on the source location at the very beginning/end of the op */
function itemDragStart(ev: DragEvent, index: number) {
  const dndEl = dndElement(ev);

  // Now that the drag has started, undo the effect of enableDrag() as
  // explained there.
  disableDrag(ev);
  ev.stopPropagation();

  if (dropTask) {
    // Only one DnD operation is allowed at a time.
    ev.preventDefault();
    return;
  }

  trace("dragStart", index, props.modelValue[index]);

  props.drag({
    dataTransfer: ev.dataTransfer!,
    fromIndex: index,
    value: props.modelValue[index],
  });

  // setTimeout() to work around a Chrome bug described here:
  // https://stackoverflow.com/questions/19639969/html5-dragend-event-firing-immediately
  setTimeout(() => {
    if (!dndEl) return;

    const rect = dndEl.getBoundingClientRect();
    ghostSize.value = {width: rect.width, height: rect.height};

    state.draggingFromIndex = index;
    sourceList = state;
    state.droppingToIndex = index;
    destList = state;
  });
}

/** Fired on the source location at the end of a drag op (regardless of
 * whether it was committed or aborted). */
function itemDragEnd() {
  // If a drop operation is committed/in progress, we don't clear the
  // DND until it actually completes.
  if (dropTask) return;

  trace("dragEnd");

  if (sourceList) sourceList.draggingFromIndex = undefined;
  sourceList = undefined;
  if (destList) destList.droppingToIndex = undefined;
  destList = undefined;

  ghostSize.value = undefined;
}

/** Fired when an item that is being dragged enters an element. */
function itemDragEnter(ev: DragEvent, index: number) {
  if (!allowDropHere(ev)) return;

  // Make the ghost mimic the size of the element it's about to enter,
  // as a way of debouncing.  This (mostly) guarantees that the ghost
  // will remain under the mouse cursor when it moves to its new
  // position, avoiding constant flickering/reshuffling if the ghost
  // enters/leaves a particular position as a result of the list being
  // re-flowed after moving the ghost.
  const el = dndElement(ev);
  if (el) {
    const rect = el.getBoundingClientRect();
    ghostSize.value = {width: rect.width, height: rect.height};
  }

  index = desiredDropPosition(ev, index);
  moveGhost(index);
}

/** Fired periodically while an element is being hovered over as a
 * potential drop target.  For stupid browser reasons, we must implement
 * both this AND dragEnter to let the browser know whether the element
 * is (still) a valid drop target. */
function itemDragOver(ev: DragEvent, index: number) {
  if (!allowDropHere(ev)) return;
  trace("itemDragOver", ev.target, index);
  index = desiredDropPosition(ev, index);
  moveGhost(index);
}

/** Special dragEnter events for parent items, which need different
 * behavior in Firefox because Firefox likes to fire these events even
 * when a child element should be consuming them instead... */
function parentDragEnter(ev: DragEvent) {
  if (ev.target && ev.target !== $top.value) return;

  // We only want to move the ghost if it's non-displacing; displacing ghosts
  // are generally used when there's more complicated flat-list styling going
  // on, so that we don't show flickering when the user is dragging over the
  // margin between list items.
  if (props.ghostDisplacesItems) return;
  if (!allowDropHere(ev)) return;

  moveGhost(displayItems.value.length);
}

/** Fired when an item is dragged away from the parent. */
function parentDragExit(ev: DragEvent) {
  // Ignore dragexit/dragleave events from our children; we only care about when
  // we leave the parent list.
  if (ev.target && ev.target !== $top.value) return;

  if (!allowDropHere(ev)) return;

  // If the user drags something completely out of the list, we don't want to
  // show a ghost at all. Clear the destination list.
  if (destList && destList !== state) {
    trace("parentDragExit", "clearing destList", ev);
    destList.droppingToIndex = undefined;
    destList = undefined;
  }
}

/** Fired continuously while an item is being dragged over its parent. */
function parentDragOver(ev: DragEvent) {
  // Called for its side-effects
  allowDropHere(ev);
}

/** Fired on the "ghost" element when the cursor enters it (e.g. because
 * it was moved to be under the cursor, to indicate where the item will
 * be dropped). */
function ghostDragEnter(ev: DragEvent) {
  ev.preventDefault(); // allow dropping here
  ev.stopPropagation(); // consume the (potential) drop
}

/** Fired on the "ghost" element repeatedly while the cursor is inside
 * it.  Just like itemDragOver(), we only want to spend enough time to
 * let the browser know this is a valid drop target.  (We determined
 * this earlier before moving the ghost into place.) */
function ghostDragOver(ev: DragEvent) {
  ev.preventDefault(); // allow dropping here
  ev.stopPropagation(); // consume the (potential) drop
}

/** Rejects the potential drop operation if this isn't a suitable
 * location for the drag that's in progress. */
function allowDropHere(ev: DragEvent): boolean {
  if (!ev.dataTransfer) return false;
  const types = ev.dataTransfer.types;
  if (props.accepts instanceof Array) {
    if (!types.find(t => props.accepts!.includes(t))) return false;
  } else if (props.accepts) {
    if (!types.includes(props.accepts)) return false;
  } else {
    return false;
  }
  ev.preventDefault();
  ev.stopPropagation();
  return true;
}

/** Computes the desired drop position depending on where the mouse cursor is in
 * the list item. Only applies to non-displacing ghosts. */
function desiredDropPosition(ev: DragEvent, hoveredIndex: number): number {
  let index = hoveredIndex;

  if (props.ghostDisplacesItems) {
    // If we are moving the ghost forward in the list from where it currently
    // is, we need to account for the fact that it's being removed from its
    // previous location, or it will appear at the entry prior to where the
    // mouse cursor actually is.
    if (state.droppingToIndex !== undefined && state.droppingToIndex <= index) {
      index++;
    }
  } else {
    // We determine the drop index based on where in the hovered item the mouse
    // cursor is--if it's nearer the previous item, we insert the dragged item
    // before (i.e. keep the index the same). If it's nearer the next item, we
    // insert after (i.e. index + 1).
    const rect = (ev.currentTarget as Element).getBoundingClientRect();

    switch (props.orientation) {
      case "horizontal":
        if (ev.offsetX > rect.width / 2) index++;
        break;
      case "vertical":
        if (ev.offsetY > rect.height / 2) index++;
        break;
    }
  }

  index = Math.min(index, displayItems.value.length);

  trace("desiredDropPosition", hoveredIndex, "->", index);
  return index;
}

/** Moves the ghost to the specified location (sort of).  We want the
 * ghost to appear at `index`, which is presumed to be the location
 * currently under the mouse cursor.  (The actual index of the ghost may
 * vary depending on how it's being moved.) */
function moveGhost(index: number) {
  if (destList && destList !== state) {
    destList.droppingToIndex = undefined;
  }
  destList = state;
  state.droppingToIndex = index;

  trace("moveGhost", index, destList);
}

/** Fired when it's time to actually perform the drop operation. */
function doDrop(ev: DragEvent) {
  if (!allowDropHere(ev)) return;
  if (!destList) return;

  ev.stopPropagation();

  // Here we start the (async) drop task, and freeze the model in both
  // the source and destination lists until the drop task completes.
  // (We do this by taking a snapshot of the current modelValue and
  // storing it in modelSnapshot.) If we don't freeze the model, the
  // user will see a momentary flicker where the model(s) snap back to
  // the pre-drag state as both model values get updated.

  console.assert(destList === state);
  console.assert(destList.droppingToIndex !== undefined);

  const drop_ev: DropAction = {
    dataTransfer: ev.dataTransfer!,
    toIndex: destList.droppingToIndex!,
  };
  dropTask = drop_ev;

  if (sourceList) {
    sourceList.modelSnapshot = Array.from(sourceList.modelValue);
  }
  state.modelSnapshot = Array.from(props.modelValue);

  trace("drop", "start", sourceList, destList);

  props
    .drop(drop_ev)
    .then(() => nextTick(), console.error) // wait for Vue model updates
    .finally(() => {
      trace("drop", "end");
      if (sourceList) {
        sourceList.modelSnapshot = undefined;
        sourceList.draggingFromIndex = undefined;
        sourceList = undefined;
      }
      if (destList) {
        destList.modelSnapshot = undefined;
        destList.droppingToIndex = undefined;
        destList = undefined;
      }
      dropTask = undefined;
      ghostSize.value = undefined;
    });
}
</script>
