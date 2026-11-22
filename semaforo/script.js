"use strict";

const TIMING = { minGreen: 5000, maxGreen: 15000, yellow: 2000, clearance: 1000, sample: 150 };
const SENSOR = { min: 5, max: 20, required: 3 };
const PHASES = [
    { axis: "A", color: "green", code: "A_VERDE", title: "Rua A liberada" },
    { axis: "A", color: "yellow", code: "A_AMARELO", title: "Rua A em atenção" },
    { axis: null, color: "red", code: "VERMELHO_PARA_B", title: "Intervalo de segurança" },
    { axis: "B", color: "green", code: "B_VERDE", title: "Rua B liberada" },
    { axis: "B", color: "yellow", code: "B_AMARELO", title: "Rua B em atenção" },
    { axis: null, color: "red", code: "VERMELHO_PARA_A", title: "Intervalo de segurança" }
];
const AXES = ["A", "B"];
const MAP = { width: 1000, height: 620, x: 500, y: 310, road: 74, crossing: 92, stop: -114 };
const STEP = 1000 / 60;
const GAP = 17;
const BRAKE = 185;
const PALETTE = ["#72bcdf", "#e3b765", "#e0e9e7", "#d67d6f", "#8ac2a1", "#a9a6cf"];
const CROSSINGS = AXES.flatMap(axis => [-1, 1].map(side => ({ axis, side, fixed: side * MAP.crossing })));

class Controller {
    constructor() {
        this.index = 0;
        this.started = 0;
        this.nextSample = TIMING.sample;
        this.cycle = 1;
        this.sensors = Object.fromEntries(AXES.map(axis => [axis, { distance: null, hits: 0, requested: false }]));
    }

    get phase() { return PHASES[this.index]; }

    signal(axis) { return this.phase.axis === axis ? this.phase.color : "red"; }

    update(time, readDistance) {
        const { axis, color } = this.phase;
        while (time + 0.0001 >= this.nextSample) {
            this.nextSample += TIMING.sample;
            for (const street of AXES) {
                const sensor = this.sensors[street];
                sensor.distance = readDistance(street);
                const detected = sensor.distance !== null && sensor.distance >= SENSOR.min && sensor.distance <= SENSOR.max;
                const monitoring = axis !== null && axis !== street;
                sensor.hits = monitoring && detected ? Math.min(SENSOR.required, sensor.hits + 1) : 0;
                sensor.requested ||= sensor.hits === SENSOR.required;
            }
        }

        const elapsed = time - this.started + 0.0001;
        const opposite = axis === "A" ? "B" : "A";
        const limit = color === "green"
            ? (this.sensors[opposite].requested ? TIMING.minGreen : TIMING.maxGreen)
            : color === "yellow" ? TIMING.yellow : TIMING.clearance;
        if (elapsed < limit) return;

        this.index = (this.index + 1) % PHASES.length;
        this.started = time;
        if (this.index === 0) this.cycle++;
        if (this.phase.color === "green") {
            const sensor = this.sensors[this.phase.axis];
            sensor.requested = false;
            sensor.hits = 0;
        }
    }
}

function makeLanes() {
    return [
        { axis: "A", direction: 1, offset: 36, first: 0.35, intervals: [2.9, 4.8, 3.2, 14, 5.4, 2.8] },
        { axis: "A", direction: -1, offset: -36, first: 1.15, intervals: [5.2, 3.4, 11, 3.2, 4.6, 7.2] },
        { axis: "B", direction: 1, offset: -36, first: 0.7, intervals: [3.1, 4.7, 13, 3.6, 4.4, 6.4] },
        { axis: "B", direction: -1, offset: 36, first: 1.75, intervals: [4.2, 5.9, 9.8, 3, 5, 7.6] }
    ].map(lane => ({
        ...lane, range: (lane.axis === "A" ? MAP.width : MAP.height) / 2,
        cars: [], spawnTime: lane.first, serial: 0
    }));
}

class Simulation {
    constructor() {
        this.time = 0;
        this.controller = new Controller();
        this.lanes = makeLanes();
        this.carsPassed = 0;
        this.peoplePassed = 0;
        this.crossings = CROSSINGS.map((crossing, index) => ({
            ...crossing, index, open: false,
            people: [0, 1, 2].map(i => ({
                direction: i === 1 ? -1 : 1, offset: (i - 1) * 8,
                speed: 76 + i * 5, coat: PALETTE[index + i],
                distance: 0, walking: false, readyAt: i * 0.65
            }))
        }));
        this.lanes.forEach((lane, index) => this.spawn(lane, [ -181, -276, -191, -230 ][index], index < 2 ? 78 : 56));
    }

    spawn(lane, position, speed = 95) {
        const index = lane.serial++;
        const van = index % 5 === 3;
        lane.cars.push({
            position, speed, committed: false, counted: false,
            length: van ? 45 : 37, width: van ? 22 : 19,
            cruise: 108 + (index * 7 + (lane.direction > 0 ? 6 : 0)) % 17,
            color: PALETTE[(index * 2 + this.lanes.indexOf(lane)) % PALETTE.length], van
        });
    }

    readDistance(axis) {
        let distance = Infinity;
        for (const lane of this.lanes) {
            if (lane.axis !== axis || lane.direction !== 1) continue;
            for (const car of lane.cars) {
                const nose = car.position + car.length / 2;
                const tail = car.position - car.length / 2;
                if (tail > MAP.stop + 11 || nose < MAP.stop - 115) continue;
                distance = Math.min(distance, Math.round((8 + Math.abs(Math.min(0, nose - MAP.stop)) * .42) * 10) / 10);
            }
        }
        return Number.isFinite(distance) ? distance : null;
    }

    updateTraffic(dt, previous) {
        for (const lane of this.lanes) {
            const signal = this.controller.signal(lane.axis);
            const yellowStarted = previous.color === "green" && previous.axis === lane.axis && signal === "yellow";
            let leader;
            for (const car of lane.cars) {
                const nose = car.position + car.length / 2;
                const gapToLine = MAP.stop - nose;
                if (yellowStarted && gapToLine > 0 && gapToLine < car.speed ** 2 / (2 * BRAKE) + 2) {
                    car.committed = !leader || leader.committed;
                }
                const freeToGo = signal === "green" || car.committed;
                const stopAt = freeToGo ? Infinity : MAP.stop - car.length / 2;
                const followingAt = leader
                    ? leader.position - (leader.length + car.length) / 2 - GAP
                    : Infinity;
                const barrier = Math.min(stopAt, followingAt);
                const room = Math.max(0, barrier - car.position);
                const desired = Math.min(car.cruise, Math.sqrt(2 * BRAKE * room));
                car.speed += Math.max(-BRAKE * dt, Math.min(105 * dt, desired - car.speed));
                const advance = Math.min(room, car.speed * dt);
                car.position += advance;
                if (advance >= room) car.speed = 0;
                if (freeToGo && car.position + car.length / 2 > MAP.stop) car.committed = true;
                if (!car.counted && car.position - car.length / 2 > MAP.crossing + 12) {
                    car.counted = true;
                    this.carsPassed++;
                }
                leader = car;
            }

            lane.cars = lane.cars.filter(car => car.position - car.length / 2 < lane.range + 26);
            const last = lane.cars.at(-1);
            const entrance = -lane.range - 25;
            if (this.time / 1000 >= lane.spawnTime && (!last || last.position - last.length / 2 > entrance + 40)) {
                const interval = lane.intervals[(lane.serial - 1) % lane.intervals.length];
                this.spawn(lane, entrance);
                lane.spawnTime = this.time / 1000 + interval;
            }
        }
    }

    updatePeople(dt) {
        const phase = this.controller.phase;
        for (const crossing of this.crossings) {
            const roadClear = this.lanes.every(lane => lane.axis !== crossing.axis || lane.cars.every(car => {
                const stripe = crossing.fixed * lane.direction;
                const nose = car.position + car.length / 2;
                const tail = car.position - car.length / 2;
                // Include cars still clearing the junction after their light went red.
                return tail > stripe + 15 || (!car.committed && nose < stripe - 15);
            }));
            const length = (MAP.road + 11) * 2;
            const timeLeft = (TIMING.minGreen - (this.time - this.controller.started)) / 1000;
            const walkingTime = length / crossing.people[0].speed + .15;
            crossing.open = phase.color === "green" && phase.axis !== crossing.axis && roadClear && timeLeft >= walkingTime;
            for (const person of crossing.people) {
                if (!person.walking && crossing.open && this.time / 1000 >= person.readyAt) {
                    person.walking = true;
                    person.distance = 0;
                }
                if (!person.walking) continue;
                person.distance += person.speed * dt;
                if (person.distance >= length) {
                    person.walking = false;
                    person.distance = 0;
                    person.direction *= -1;
                    person.readyAt = this.time / 1000 + 6 + crossing.index * .6;
                    this.peoplePassed++;
                }
            }
        }
    }

    step(dt = STEP) {
        this.time += dt;
        const previous = this.controller.phase;
        this.controller.update(this.time, axis => this.readDistance(axis));
        this.updateTraffic(dt / 1000, previous);
        this.updatePeople(dt / 1000);
    }
}

const canvas = document.getElementById("city");
const ctx = canvas.getContext("2d");
const scenery = document.createElement("canvas");
scenery.width = MAP.width * 2;
scenery.height = MAP.height * 2;
const ground = scenery.getContext("2d");
ground.scale(2, 2);

function rect(g, x, y, w, h, fill) {
    g.fillStyle = fill;
    g.fillRect(x, y, w, h);
}

function rounded(g, x, y, w, h, radius, fill) {
    g.beginPath();
    g.roundRect(x, y, w, h, radius);
    g.fillStyle = fill;
    g.fill();
}

function circle(g, x, y, radius, fill) {
    g.beginPath();
    g.arc(x, y, radius, 0, Math.PI * 2);
    g.fillStyle = fill;
    g.fill();
}

function line(g, x1, y1, x2, y2, width, color) {
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.lineWidth = width;
    g.strokeStyle = color;
    g.stroke();
}

function label(g, value, x, y, size, color, weight = 650) {
    g.font = weight + " " + size + "px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = color;
    g.fillText(value, x, y);
}

function tree(g, x, y, scale = 1) {
    g.save();
    g.translate(x, y);
    g.scale(scale, scale);
    circle(g, 9, 10, 20, "#1d302847");
    circle(g, 0, 0, 18, "#385d45");
    circle(g, -6, -4, 13, "#527b53");
    circle(g, 5, -4, 11, "#628d5e");
    circle(g, -4, -10, 6, "#719862");
    g.restore();
}

function building(g, x, y, w, h, roof, accent) {
    rounded(g, x + 14, y + 15, w, h, 4, "#20313059");
    rounded(g, x, y, w, h, 3, "#667474");
    rounded(g, x + 2, y + 2, w - 5, h - 7, 2, accent);
    rect(g, x + 8, y + 8, w - 16, h - 21, roof);
    line(g, x + 8, y + 9, x + w - 8, y + 9, 2, "#f3f3df62");
    for (let p = x + 12; p < x + w - 13; p += 22) {
        rect(g, p, y + h - 8, 12, 4, "#405f63");
    }
    for (let n = 0; n < 2; n++) {
        const ax = x + w * .58 + n * 23;
        const ay = y + h * .36;
        rect(g, ax + 3, ay + 4, 16, 17, "#293e4047");
        rect(g, ax, ay, 16, 17, "#d2d7ce");
        for (let groove = 4; groove < 16; groove += 4) rect(g, ax + 3, ay + groove, 10, 1, "#748987");
    }
}

function bench(g, x, y) {
    rect(g, x, y + 4, 23, 8, "#26352b30");
    rounded(g, x, y, 23, 7, 2, "#996b46");
    line(g, x + 2, y + 2, x + 21, y + 2, 1, "#d2a174");
}

function drawScenery() {
    const g = ground;
    const { x, y, width, height, road, crossing, stop } = MAP;
    rect(g, 0, 0, width, height, "#7c9b72");
    const blocks = [[0, 0, 426, 236], [574, 0, 426, 236], [0, 384, 426, 236], [574, 384, 426, 236]];
    blocks.forEach(([left, top, w, h], index) => {
        rect(g, left, top, w, h, index % 2 ? "#b6b6a2" : "#c0bfab");
        rect(g, left + 24, top + 24, w - 48, h - 48, index === 2 ? "#789c6a" : "#8eaa78");
        for (let px = left; px < left + w; px += 19) {
            rect(g, px, top, 1, 23, "#89989065");
            rect(g, px, top + h - 23, 1, 23, "#89989065");
        }
        for (let py = top; py < top + h; py += 19) {
            rect(g, left, py, 23, 1, "#89989065");
            rect(g, left + w - 23, py, 23, 1, "#89989065");
        }
    });

    building(g, 48, 42, 142, 98, "#a59883", "#dbceb1");
    building(g, 213, 36, 143, 92, "#748f92", "#c2d2cb");
    building(g, 676, 38, 164, 104, "#a77f68", "#dfba9c");
    building(g, 862, 71, 108, 99, "#7d9890", "#bed0bb");
    building(g, 688, 479, 172, 105, "#879396", "#c6d0d0");
    building(g, 866, 461, 104, 91, "#af916f", "#dac7a4");

    rounded(g, 47, 414, 322, 169, 11, "#638b62");
    rounded(g, 93, 436, 223, 120, 31, "#cfbfa0");
    rounded(g, 110, 451, 189, 90, 24, "#789e6a");
    rect(g, 199, 436, 12, 120, "#cfbfa0");
    rect(g, 93, 490, 223, 12, "#cfbfa0");
    circle(g, 204, 495, 24, "#b8baa7");
    circle(g, 204, 495, 19, "#508b96");
    circle(g, 201, 491, 12, "#79b3ba");
    circle(g, 204, 495, 4, "#dbeddf");
    for (const [tx, ty, size] of [[77,172,1],[133,185,.77],[201,174,.83],[273,173,.93],[339,178,1],[394,74,.83],[394,128,.7],
        [609,79,1],[630,140,.85],[677,179,.83],[734,183,.98],[818,178,.8],[915,187,.83],[963,191,.76],
        [74,449,.82],[78,535,.94],[132,471,.83],[258,522,.76],[281,472,.8],[337,454,.84],[342,535,1],[392,566,.94],
        [619,465,1],[640,528,.89],[633,570,.67],[697,425,.83],[768,421,.91],[836,430,.78],[917,576,.86],[970,573,.69]]) {
        tree(g, tx, ty, size);
    }
    [[148,448],[229,534],[322,468],[341,418],[115,206],[774,205],[784,440]].forEach(([bx, by]) => bench(g, bx, by));

    rect(g, 0, y - road, width, road * 2, "#3a4549");
    rect(g, x - road, 0, road * 2, height, "#3a4549");
    let seed = 314;
    for (let i = 0; i < 5000; i++) {
        seed = (seed * 16807) % 2147483647;
        const px = seed % width;
        seed = (seed * 16807) % 2147483647;
        const py = seed % height;
        if (Math.abs(px - x) < road || Math.abs(py - y) < road) {
            rect(g, px, py, i % 3 === 0 ? 2 : 1, 1, i % 2 ? "#c5ded814" : "#141c221e");
        }
    }

    for (const side of [-1, 1]) {
        const hx = x + side * (road + 1);
        const vy = y + side * (road + 1);
        const endX = side < 0 ? 0 : width;
        const endY = side < 0 ? 0 : height;
        for (const edge of [-1, 1]) {
            line(g, hx, y + edge * (road - 2), endX, y + edge * (road - 2), 4, "#84918a");
            line(g, x + edge * (road - 2), vy, x + edge * (road - 2), endY, 4, "#84918a");
        }
        for (let d = 130; d < 500; d += 35) {
            line(g, x + side * d, y - 2, x + side * (d + 17), y - 2, 2, "#d4ad64");
            line(g, x + side * d, y + 2, x + side * (d + 17), y + 2, 2, "#d4ad64");
        }
        for (let d = 130; d < 310; d += 35) {
            line(g, x - 2, y + side * d, x - 2, y + side * (d + 17), 2, "#d4ad64");
            line(g, x + 2, y + side * d, x + 2, y + side * (d + 17), 2, "#d4ad64");
        }
        line(g, x + side * -stop, y - side * 67, x + side * -stop, y - side * 5, 3, "#eee8d7");
        line(g, x + side * 5, y + side * -stop, x + side * 67, y + side * -stop, 3, "#eee8d7");
        for (let d = -64; d <= 60; d += 12) {
            rounded(g, x + side * crossing - 10, y + d, 20, 6, 1, "#e6e3d4");
            rounded(g, x + d, y + side * crossing - 10, 6, 20, 1, "#e6e3d4");
        }
        for (const crossSide of [-1, 1]) {
            rounded(g, x + side * crossing - 12, y + crossSide * (road + 2) - 3, 24, 7, 2, "#d5b473");
            rounded(g, x + crossSide * (road + 2) - 3, y + side * crossing - 12, 7, 24, 2, "#d5b473");
        }
    }

    for (const lane of makeLanes()) {
        const axisA = lane.axis === "A";
        const angle = axisA ? (lane.direction > 0 ? 0 : Math.PI) : lane.direction * Math.PI / 2;
        const px = axisA ? x - lane.direction * 167 : x + lane.offset;
        const py = axisA ? y + lane.offset : y - lane.direction * 167;
        g.save();
        g.translate(px, py);
        g.rotate(angle);
        line(g, -12, 0, 9, 0, 2.5, "#e4e5d39e");
        line(g, 2, -5, 9, 0, 2.5, "#e4e5d39e");
        line(g, 2, 5, 9, 0, 2.5, "#e4e5d39e");
        g.restore();
    }

    rounded(g, 27, 293, 82, 28, 6, "#28383c");
    label(g, "RUA A", 68, 307, 14, "#ecf1e8");
    rounded(g, 462, 47, 76, 28, 6, "#28383c");
    label(g, "RUA B", 500, 61, 14, "#ecf1e8");
    rounded(g, 96, 553, 102, 22, 4, "#476750");
    label(g, "PRAÇA CENTRAL", 147, 564, 10, "#f1edda");
    rounded(g, 907, 43, 54, 44, 6, "#293e39e8");
    label(g, "N", 934, 56, 12, "#f1f5e8");
    label(g, "▲", 934, 71, 13, "#a5e0be");
}

const SIGNAL_STYLES = {
    red: ["#ff626d", "#5c2d36"],
    yellow: ["#ffd065", "#5c4d33"],
    green: ["#59e7ab", "#295348"]
};
const SIGNAL_LABELS = { green: "Verde", yellow: "Amarelo", red: "Vermelho" };

function drawSignal(x, y, angle, active) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    line(ctx, 1, 3, 34, 8, 5, "#15202645");
    circle(ctx, 0, 0, 6, "#4c5c58");
    circle(ctx, 0, 0, 3, "#9daca0");
    line(ctx, 0, 0, 21, 0, 4, "#23353a");
    rounded(ctx, 16, -13, 33, 26, 5, "#263635");
    rounded(ctx, 17, -12, 30, 23, 4, "#142226");
    Object.entries(SIGNAL_STYLES).forEach(([color, [lit, dim]], index) => {
        const px = 23 + index * 9;
        if (active === color) circle(ctx, px, 0, 6, lit + "42");
        circle(ctx, px, 0, 3.4, active === color ? lit : dim);
    });
    ctx.restore();
}

function drawCar(lane, car) {
    const eastWest = lane.axis === "A";
    const x = MAP.x + (eastWest ? lane.direction * car.position : lane.offset);
    const y = MAP.y + (eastWest ? lane.offset : lane.direction * car.position);
    const angle = eastWest ? (lane.direction > 0 ? 0 : Math.PI) : lane.direction * Math.PI / 2;
    const half = car.length / 2;
    const side = car.width / 2;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    rounded(ctx, -half + 3, -side + 4, car.length + 2, car.width + 1, 5, "#15222572");
    for (const ax of [-half + 7, half - 11]) {
        rounded(ctx, ax, -side - 1, 5, car.width + 2, 2, "#182328");
    }
    rounded(ctx, -half, -side, car.length, car.width, 5, car.color);
    rounded(ctx, -half + 6, -side + 2, car.length - 15, car.width - 4, 4, "#294049");
    const roofLength = car.van ? car.length - 19 : car.length - 25;
    rounded(ctx, -half + 8, -side + 3, roofLength, car.width - 6, 3, car.color);
    line(ctx, -half + 11, -side + 4, -half + 6 + roofLength, -side + 4, 1, "#fff5e88d");
    for (const d of [-1, 1]) {
        rounded(ctx, half - 4, d * (side - 3) - 1, 3, 2.5, 1, "#fff4cf");
        rounded(ctx, -half + 1, d * (side - 3) - 1, 3, 2.5, 1, car.speed < 5 ? "#ff8b82" : "#a73a45");
    }
    ctx.restore();
}

function drawSensors(sim) {
    for (const lane of sim.lanes) {
        if (lane.direction !== 1) continue;
        const a = lane.axis === "A";
        const parallel = (MAP.stop - 36) * lane.direction;
        const curb = lane.offset > 0 ? MAP.road + 3 : -MAP.road - 3;
        const x = MAP.x + (a ? parallel : curb);
        const y = MAP.y + (a ? curb : parallel);
        const sensor = sim.controller.sensors[lane.axis];
        const marked = sensor.distance !== null && sensor.distance >= SENSOR.min && sensor.distance <= SENSOR.max;
        const color = marked ? "#a1edff" : "#70b8cc";
        circle(ctx, x + 1, y + 2, 7, "#22383b");
        circle(ctx, x, y, 5, color);
        circle(ctx, x, y, 2.5, "#22383b");
    }
}

function drawPeople(sim) {
    for (const crossing of sim.crossings) {
        const alongX = crossing.axis === "B";
        for (const side of [-1, 1]) {
            const curb = side * (MAP.road + 13);
            const pole = crossing.fixed + 15 * crossing.side;
            const x = MAP.x + (alongX ? curb : pole);
            const y = MAP.y + (alongX ? pole : curb);
            rounded(ctx, x - 5, y - 5, 10, 10, 2, "#253739");
            circle(ctx, x, y, 2.6, crossing.open ? "#6cf5b3" : "#f67579");
        }
        crossing.people.forEach((person, index) => {
            const distance = person.walking ? person.distance : -3 - index * 1.25;
            const across = person.direction * (distance - MAP.road - 11);
            const stripe = crossing.fixed + person.offset;
            const x = MAP.x + (alongX ? across : stripe);
            const y = MAP.y + (alongX ? stripe : across);
            const stride = person.walking ? Math.sin(person.distance * .34) * 3 : 0;
            const rotation = alongX ? (person.direction === 1 ? 0 : Math.PI) : person.direction * Math.PI / 2;
            ctx.save();
            ctx.translate(x, y);
            circle(ctx, 2.8, 3.1, 5.1, "#26373354");
            ctx.rotate(rotation);
            line(ctx, 0, -2.4, stride, -2.4, 2.4, "#24363c");
            line(ctx, 0, 2.4, -stride, 2.4, 2.4, "#24363c");
            rounded(ctx, -3.6, -4.4, 6.4, 8.8, 2.6, person.coat);
            circle(ctx, 1.2, 0, 2.65, ["#ebbb91", "#aa7157", "#d79b73"][index]);
            ctx.restore();
        });
    }
}

function draw(sim) {
    const sx = canvas.width / MAP.width;
    const sy = canvas.height / MAP.height;
    const scale = Math.min(sx, sy * 1.15);
    if (!scale) return;
    const dx = (canvas.width - MAP.width * scale) / 2;
    const dy = (canvas.height - MAP.height * scale) / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#263d38";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(scale, 0, 0, scale, dx, dy);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, MAP.width, MAP.height);
    ctx.clip();
    ctx.drawImage(scenery, 0, 0, MAP.width, MAP.height);
    drawSensors(sim);
    for (const lane of sim.lanes) {
        for (const car of lane.cars) drawCar(lane, car);
    }
    drawPeople(sim);
    const a = sim.controller.signal("A");
    const b = sim.controller.signal("B");
    drawSignal(370, 398, -Math.PI / 2, a);
    drawSignal(630, 222, Math.PI / 2, a);
    drawSignal(412, 180, 0, b);
    drawSignal(588, 440, Math.PI, b);
    ctx.restore();
}

const byId = id => document.getElementById(id);
const phase = byId("phase");
const track = PHASES.map(item => {
    const segment = document.createElement("i");
    segment.style.setProperty("--tone", "var(--" + item.color + ")");
    segment.title = item.code;
    byId("phase-track").append(segment);
    return segment;
});

function replaceText(element, text) {
    if (element.textContent !== text) element.textContent = text;
}

const digits = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function renderPanel(sim) {
    const { controller } = sim;
    const current = controller.phase;
    phase.dataset.tone = current.color;
    replaceText(byId("phase-title"), current.title);
    replaceText(byId("phase-code"), current.code);
    replaceText(byId("phase-limit"), current.color === "green" ? "5–15 s" : current.color === "yellow" ? "2 s" : "1 s");
    replaceText(byId("elapsed"), digits.format(Math.floor((sim.time - controller.started) / 100) / 10));
    replaceText(byId("cycle"), String(controller.cycle).padStart(2, "0"));
    replaceText(byId("vehicles"), String(sim.carsPassed));
    replaceText(byId("people"), String(sim.peoplePassed));
    track.forEach((segment, index) => {
        segment.setAttribute("aria-current", index === controller.index ? "step" : "false");
    });

    for (const axis of AXES) {
        const signal = controller.signal(axis);
        const sensor = controller.sensors[axis];
        byId(axis).dataset.signal = signal;
        replaceText(byId("signal-" + axis), SIGNAL_LABELS[signal]);
        replaceText(byId("distance-" + axis), sensor.distance === null ? "Sem eco" : digits.format(sensor.distance) + " cm");
        const reading = byId("reading-" + axis);
        reading.classList.toggle("request", sensor.requested);
        replaceText(reading, sensor.requested ? "Demanda confirmada" : sensor.hits + "/3 leituras de presença");
    }

    const open = sim.crossings.find(crossing => crossing.open);
    const clearing = sim.crossings.some(crossing => crossing.people.some(person => person.walking));
    byId("walking").classList.toggle("open", Boolean(open));
    replaceText(byId("walk-label"), open ? "Travessias na Rua " + open.axis + " liberadas"
        : clearing ? "Pedestres concluindo a travessia" : "Travessias fechadas");
}

let simulation = new Simulation();
let paused = false;
let lastFrame;
let accumulator = 0;

function resize() {
    const bounds = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(bounds.width * ratio);
    canvas.height = Math.round(bounds.height * ratio);
    draw(simulation);
}

function frame(now) {
    if (lastFrame === undefined) lastFrame = now;
    if (!paused) {
        accumulator += Math.min(now - lastFrame, 250);
        while (accumulator >= STEP) {
            simulation.step();
            accumulator -= STEP;
        }
        draw(simulation);
        renderPanel(simulation);
    }
    lastFrame = now;
    requestAnimationFrame(frame);
}

function togglePause() {
    paused = !paused;
    byId("live").classList.toggle("paused", paused);
    replaceText(byId("live"), paused ? "Simulação pausada" : "Simulação ativa");
    replaceText(byId("pause"), paused ? "Retomar" : "Pausar");
    lastFrame = undefined;
}

async function toggleFullscreen() {
    if (!document.fullscreenEnabled) return;
    try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
    } catch {
        byId("fullscreen").title = "Tela cheia indisponível nesta janela";
    }
}

byId("pause").addEventListener("click", togglePause);
byId("reset").addEventListener("click", () => {
    simulation = new Simulation();
    accumulator = 0;
    lastFrame = undefined;
    if (paused) togglePause();
    draw(simulation);
    renderPanel(simulation);
});
byId("fullscreen").addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", () => {
    replaceText(byId("full-label"), document.fullscreenElement ? "Sair da tela cheia" : "Tela cheia");
});
document.addEventListener("keydown", event => {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.target.closest("button, input, textarea, select, [contenteditable]")) return;
    if (event.code === "Space") {
        event.preventDefault();
        togglePause();
    }
    if (event.key.toLowerCase() === "f") toggleFullscreen();
});
document.addEventListener("visibilitychange", () => { lastFrame = undefined; });

drawScenery();
new ResizeObserver(resize).observe(canvas);
renderPanel(simulation);
requestAnimationFrame(frame);
