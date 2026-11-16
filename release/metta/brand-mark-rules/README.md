# Omega mark rules

`omega-mark.metta` is the source of truth for how the Omega mark behaves in any interface. The shape never changes: the facing crescents traced from the glass master. The environment (a look, app or hive) sets its material, and the action sets how it changes. `gen_rules.py` runs the rules through PeTTa and writes `rules.json`. Renderers (WebGL in the hive, Blender for stills) only draw what the rules decide.

The environments are the interface looks (cosmos, classic, professional, construct, still, flux, canvas, littleworld) plus the brand mark itself and the materials the brand film uses (hyperon, atomspace, glitch, bush, cake, voxel, puppy, balloon, neonfur).

```sh
PETTA_PATH=/path/to/PeTTa python3 gen_rules.py      # writes rules.json
PETTA_PATH=/path/to/PeTTa sh check_rules.sh         # passes if rules.json is exactly what the rules decide
```

Licence: the repository's licence (MIT).
