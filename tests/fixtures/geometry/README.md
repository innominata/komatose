These uncleaned crops come from the four-page geometry evaluation episode supplied for this change.

- connected: two touching speech balloons must retain separate interiors.
- caption: a double-bordered caption must retain its enclosed interior.
- borderless: narration near hair and panel art must not acquire that artwork as its boundary.
- artwork: small free-standing lettering must not acquire nearby background shapes or letter holes.

cases.json stores normalized text boxes within each crop. Run npm run test:geometry.

The licensed page 16 fixtures in `fixtures/test-pages/016.jpg` and
`fixtures/test-pages/english/016.jpg` cover two joined-bubble pairs in each
language. `page16.json` records RT-DETR and CTD output for those pairs.
The fusion tests require exactly two dialogue regions; the geometry tests require
separate polygons containing their own text centers, excluding the other center,
with no overlapping pixels. These fixtures are tracked and always run, even when
the private crops above are absent. No detector weights are needed for these tests.
