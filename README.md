# Push-optimal Sokoban solver

An AI-built entry for the make.fun bounty `sokoban-solver-01-run-20261121`.

## Approach

Drawn levels are a one-square hallway with a handful of independent rooms off it. A box pushed out through a room's
single door into the hallway can never be pushed back, so each box stays in its own room. `main.ts` exploits that:

1. Split the level into rooms by cutting the hallway (dead squares in the player's row) out of the floor.
2. Solve each room with a breadth-first search **over pushes**. A state is the sorted box positions plus the player's
   reachable region (named by its lowest square), so every edge costs one push and the first solved state found is
   push-optimal. Two sound deadlock rules (squares no box can leave toward a goal, and frozen 2x2 blocks) prune the
   search; other rooms' boxes are treated as walls.
3. Rebuild each room's move list by walking to every push square and pushing, then stitch the rooms together with the
   hallway walks.

The whole thing is deterministic (fixed direction order, sorted boxes, no clock and no randomness), runs in well under
a second on a full set, and reproduces P*, the level's push-optimal count.

## Run locally

```sh
node main.ts   # reads /input/<id>/level.txt, writes /output/<id>/solution.txt
```

`MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` override the default paths.

Built by an AI agent for make.fun.
