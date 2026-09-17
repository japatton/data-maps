# Studio tasks

The README's [Studio section][studio] describes every feature. This is the
other shape: one heading per thing you might actually want to do.

## Fix a field's ECS target

Technologies → your technology → the dataset in the left rail → the format
tab → find the row in the **Fields** table → change **ECS target**.

The field completes against the ECS dictionary as you type, but it is a
text box rather than a closed list: a name that is not in ECS can be
typed, and validation catches it and blocks **Review changes** until it
is fixed. Set **Status** to match what you have actually done. `mapped` when the
value lands correctly; `partial` when work is still owed on it — which
includes a field with no ECS target at all, if something is still owed.
That distinction is a work queue, and `unmapped` is a resting state
rather than a to-do; the README draws the line at [mapping status][mstat].

## Add a field the map is missing

**+ Add field** at the bottom of the Fields table. Give the vendor's own
name for it, not a tidied version — someone will grep a real record for
that string.

## Export a field table

The **JSON**, **CSV** and **YAML** buttons beside **+ Add field** download
the format you are looking at. CSV opens in Excel and carries the
technology, dataset and format on every row, so it stands alone once
mailed.

## Attach an example record

Open the dataset and find **Attach a record**, then press **Attach**.
What counts as evidence, and which repository a real record may go to,
is in the README's [Studio section][studio].

## Change how a feed reaches Elastic

Open the dataset and edit **Route**, choosing the side you mean. What the
sides are and how they differ is in the README's
[route portrayal and the guard][route].

## Recover a draft you thought you lost

Studio keeps unsaved work in your browser. Reopen the technology and a
banner offers **Resume** or **Discard** — the picker already marks it as
having a draft. Press **Resume** and it comes back; **Discard** throws it
away and reloads what is published.

## Delete a technology

Open the technology and press **Delete technology**. You must type the id
to confirm. It removes the map, its catalog row and its example records in
one merge request, and it cannot be undone from Studio — recovery is
reverting that merge request.

The button is disabled for a technology that is neither published nor in
the catalog, because there would be nothing to remove.

[studio]: {{REPO}}/README.md#studio
[route]: {{REPO}}/README.md#route-portrayal-and-the-guard
[mstat]: {{REPO}}/README.md#mapping-status
