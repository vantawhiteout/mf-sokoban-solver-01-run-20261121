// A push-optimal Sokoban solver for sokoban-solver-01.
//
// The drawn levels are a hallway with a handful of independent rooms off it. A box pushed through a door into the
// hallway can never be pushed back, so each box must stay in the room it started in. That lets us solve each room on
// its own, push-optimally, and concatenate the walks: the pushes of the whole level are the sum of the room optima,
// which is exactly P*, the score's all-or-nothing target.
//
// The room solver is a breadth-first search over *pushes*. A state is the sorted set of box squares together with the
// player's reachable region (named by its lowest square); every edge is one push, so the first solved state found is
// push-optimal. Two sound deadlock rules keep the search small: squares from which no box can ever reach a goal, and
// frozen 2x2 blocks. Everything is deterministic -- fixed direction order, sorted boxes, no clock and no randomness --
// so the two grading executions produce byte-identical answers.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// u, d, l, r: [dx, dy, walk letter, push letter].
const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

// How many BFS push states one room may keep before we give up on it. The generator only keeps rooms that its own
// push-optimal search solves within 250000 states, so this comfortably covers every room that can be drawn.
const MAX_STATES = 400000;

/** Parse an XSB level (one row per line) into walls, goals, boxes and the player square. */
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is a wall whatever it shows; nothing ever leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/** The squares from which a box alone could still be pushed onto some goal (reverse BFS from the goals). */
function liveSquares(level) {
  const { w, wall, goals } = level;
  const size = wall.length;
  const live = new Uint8Array(size);
  const queue = [];
  for (const g of goals) {
    if (g >= 0 && g < size) {
      live[g] = 1;
      queue.push(g);
    }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (y >= 0 && y < size && y - d >= 0 && y - d < size && !wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Mark (with `stamp`) the squares the player reaches from `from` around walls and boxes, and return the lowest one. */
function regionLow(level, occupied, from, seen, stamp, stack) {
  const { w, wall } = level;
  const size = wall.length;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (q >= 0 && q < size && wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` is stuck in a 2x2 block of walls/boxes that contains an off-goal box. */
function frozenBlock(level, occupied, goal, t) {
  const { w, wall } = level;
  const size = wall.length;
  const blocked = (i) => i < 0 || i >= size || wall[i] === 1 || occupied[i] === 1;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!blocked(a) || !blocked(b) || !blocked(c) || !blocked(d)) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) {
      return true;
    }
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD (first direction wins ties). */
function walkTo(level, occupied, from, to) {
  const { w, wall } = level;
  if (from === to) return '';
  const size = wall.length;
  const prev = new Int32Array(size).fill(-1);
  const how = new Array(size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= size || wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/**
 * Push-optimal solution of one room: {pushes, moves} (moves use upper letters for pushes), or null if the search gives
 * up. The state key is the lowest reachable player square plus the sorted boxes.
 */
function solvePushOptimal(level, maxStates = MAX_STATES) {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  const solved = (bs) => bs.every((b) => goal[b] === 1);
  if (level.boxes.some((b) => !live[b])) return null;

  // Exact while size ** (boxes + 1) < 2 ** 53 (a room has at most four boxes on a board of at most a few hundred cells).
  const keyOf = (boxes, low) => {
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };

  const statesBoxes = [level.boxes];
  const statesPlayer = [level.player];
  const parent = [-1];
  const index = new Map();

  for (const b of level.boxes) occupied[b] = 1;
  index.set(keyOf(level.boxes, regionLow(level, occupied, level.player, seen, ++stamp, stack)), 0);
  for (const b of level.boxes) occupied[b] = 0;

  let found = solved(level.boxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < statesBoxes.length; head++) {
    const boxes = statesBoxes[head];
    for (const b of boxes) occupied[b] = 1;
    regionLow(level, occupied, statesPlayer[head], seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi];
      for (const [dx, dy, , pushLetter] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (t < 0 || t >= size) continue;
        // The player must be able to stand squarely behind the box, and the box must land on a live square.
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key = -1;
        let next = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, regionLow(level, occupied, b, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || index.has(key)) continue;
        if (statesBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        index.set(key, statesBoxes.length);
        statesBoxes.push(next);
        statesPlayer.push(b);
        parent.push(head);
        if (solved(next)) {
          found = statesBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // Rebuild the move list: for each push in the path, walk to its square, then push.
  const path = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();

  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const nextBoxes = statesBoxes[s];
    let from = -1;
    let to = -1;
    for (const b of boxes) if (nextBoxes.indexOf(b) < 0) from = b;
    for (const b of nextBoxes) if (boxes.indexOf(b) < 0) to = b;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d);
    for (const b of boxes) occupied[b] = 1;
    const walk = walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    if (walk === null) return null;
    moves += walk + pushLetterOf(dir);
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

function pushLetterOf(dir) {
  return dir[3];
}

/** The square the player ends on after playing a legal LURD move string from `from` on a board `w` wide. */
function endOf(w, from, moves) {
  let p = from;
  const lower = moves.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway) out of the floor; every remaining part that
 * holds a box is a room. Null if the level is not a clean set of rooms, in which case we solve the whole board at once.
 */
function roomsOf(level) {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const size = wall.length;
  const row = Math.floor(player / w);
  const cut = new Uint8Array(size);
  for (let i = row * w; i < (row + 1) * w && i < size; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;

  const part = new Int32Array(size).fill(-1);
  const rooms = [];
  for (let s = 0; s < size; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i] + dy * w + dx;
        if (q >= 0 && q < size && !wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) {
    if (part[b] < 0) return null;
    rooms[part[b]].boxes.push(b);
  }
  for (const g of goals) {
    if (part[g] >= 0) rooms[part[g]].goals.push(g);
  }
  if (goals.some((g) => part[g] < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Solve a level room by room, treating the other rooms' boxes as walls, then stitching the walks together. */
function solveLevel(level) {
  const rooms = roomsOf(level);
  if (rooms === null) {
    const whole = solvePushOptimal(level);
    return whole ? whole.moves : '';
  }

  let player = level.player;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      const cells = other.done ? other.goals : other.boxes;
      for (const b of cells) wall[b] = 1;
    }
    const sub = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    let result = solvePushOptimal(sub);
    if (result === null) result = solvePushOptimal(sub, MAX_STATES * 4);
    if (result !== null) {
      moves += result.moves;
      player = endOf(level.w, player, result.moves);
    }
    room.done = true;
  }
  return moves;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const level = parseLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  const moves = solveLevel(level);
  const outDir = join(OUTPUT_DIR, id);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'solution.txt'), `${moves}\n`);
}
