// Builds the demo shop database (SQLite): customers and a year and a half of orders.
import { DatabaseSync } from 'node:sqlite'
import { rmSync } from 'node:fs'

const FIRST = ['Olivia', 'Liam', 'Emma', 'Noah', 'Ava', 'Lucas', 'Sofia', 'Mateo', 'Mia', 'Ethan', 'Isabella', 'Leo', 'Amelia', 'Hugo', 'Chloe', 'Arthur', 'Grace', 'Daniel', 'Laura', 'Gabriel']
const LAST = ['Chen', 'Silva', 'Martins', 'Novak', 'Rossi', 'Kim', 'Garcia', 'Müller', 'Dubois', 'Costa', 'Tanaka', 'Smith', 'Oliveira', 'Weber', 'Lopez', 'Andersen', 'Moreau', 'Santos', 'Fischer', 'Nakamura']

/** Deterministic PRNG so every recording shows the same data. */
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function seedShop(file, { customers = 2000, orders = 200_000 } = {}) {
  rmSync(file, { force: true })
  const db = new DatabaseSync(file)
  const rnd = random(42)
  db.exec(`
    CREATE TABLE customers (
      customer_id INTEGER PRIMARY KEY,
      customer_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL
    );
    CREATE TABLE orders (
      order_id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers (customer_id),
      total_amount NUMERIC(10, 2) NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX orders_customer ON orders (customer_id);
    CREATE INDEX orders_created ON orders (created_at);
  `)
  db.exec('BEGIN')
  const addCustomer = db.prepare('INSERT INTO customers VALUES (?, ?, ?, ?, ?)')
  for (let id = 1; id <= customers; id++) {
    const first = FIRST[Math.floor(rnd() * FIRST.length)]
    const last = LAST[Math.floor(rnd() * LAST.length)]
    const day = new Date(Date.UTC(2023, 0, 1) + Math.floor(rnd() * 1000) * 86_400_000).toISOString().slice(0, 10)
    addCustomer.run(id, `${first} ${last}`, `${first}.${last}${id}@example.com`.toLowerCase(), rnd() < 0.85 ? 'ACTIVE' : 'INACTIVE', day)
  }
  const addOrder = db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?, ?)')
  const start = Date.UTC(2025, 0, 1)
  const span = Date.UTC(2026, 9, 1) - start
  const statuses = ['PAID', 'PAID', 'PAID', 'SHIPPED', 'SHIPPED', 'PENDING', 'REFUNDED']
  for (let id = 1; id <= orders; id++) {
    // Skewed towards a few big customers so the ranking is interesting.
    const customer = 1 + Math.floor(Math.pow(rnd(), 1.6) * customers)
    const amount = Math.round((15 + Math.pow(rnd(), 2.2) * 900) * 100) / 100
    const at = new Date(start + Math.floor(rnd() * span)).toISOString().slice(0, 19).replace('T', ' ')
    addOrder.run(id, customer, amount, statuses[Math.floor(rnd() * statuses.length)], at)
  }
  db.exec('COMMIT')
  db.close()
}
