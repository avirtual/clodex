# hint-arm.js

## rank

Each await in `rank` is followed by a generation check (`stale`), because `onDraft`, `disarm` and `forget` bump the key's generation while a rank is parked on `semantic.rank` or the `setImmediate` yield. Dropping a post-await check lets a discarded draft arm its hint, a forgotten seat re-create its `armed`/`offered` state, or an older draft that finishes last overwrite the newer hint on the fixed `HINT_ID`.

## fire

Releases the hold only when `holdGen` matches the pass's generation: a stale pre-arm pass that finds nothing must not release the hold a newer `onDraft` opened, or an injected turn spends the newer pre-armed hint before the operator's own Enter.

## onSubmit

Does not bump the generation: `_armSubmit` in session-manager.js calls the final `onDraft` and then `onSubmit` synchronously, so a bump here cancels the Enter pass it follows. That final `onDraft` has already bumped past any older rank.
