import { Hono } from 'hono'

const app = new Hono<{ Bindings: Env }>()

type HomeRow = {
  id: string
  name: string
}

type MemberRow = {
  id: string
  home_id: string
  name: string
  seq: number
}

type BillRow = {
  id: string
  home_id: string
  title: string
  total_cents: number
  created_at: string
}

type ShareRow = {
  id: string
  bill_id: string
  member_id: string
  position: number
  amount_cents: number
  paid_at: string | null
  idempotency_key: string | null
}

type BalanceRow = {
  member_id: string
  name: string
  outstanding_cents: number
}

type ShareResponse = {
  id: string
  memberId: string
  amountCents: number
  paidAt: string | null
}

async function parseJsonBody(c: {
  req: { json: () => Promise<unknown> }
}): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json()
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      return body as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

function isNonEmptyString(val: unknown): val is string {
  return typeof val === 'string' && val.trim().length > 0
}

function isPositiveInteger(val: unknown): val is number {
  return typeof val === 'number' && Number.isInteger(val) && val > 0 && Number.isSafeInteger(val)
}

app.get('/api/health', (c) => c.json({ status: 'ok' }))

app.get('/api/homes', async (c) => {
  const homesResult = await c.env.DB.prepare(
    'SELECT id, name FROM homes ORDER BY created_at ASC, rowid ASC',
  ).all<HomeRow>()

  return c.json({ homes: homesResult.results })
})

app.post('/api/homes', async (c) => {
  const body = await parseJsonBody(c)
  if (!body || !isNonEmptyString(body.name)) {
    return c.json({ error: 'Invalid home name' }, 422)
  }

  const id = crypto.randomUUID()
  const name = body.name.trim()
  const createdAt = new Date().toISOString()

  await c.env.DB.prepare('INSERT INTO homes (id, name, created_at) VALUES (?, ?, ?)')
    .bind(id, name, createdAt)
    .run()

  return c.json({ id, name }, 201)
})

app.get('/api/homes/:homeId', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id, name FROM homes WHERE id = ?')
    .bind(homeId)
    .first<HomeRow>()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const [membersResult, billsResult, sharesResult, balancesResult] = await c.env.DB.batch([
    c.env.DB.prepare(
      'SELECT id, home_id, name, seq FROM members WHERE home_id = ? ORDER BY seq ASC',
    ).bind(homeId),
    c.env.DB.prepare(
      'SELECT id, home_id, title, total_cents, created_at FROM bills WHERE home_id = ? ORDER BY created_at ASC, rowid ASC',
    ).bind(homeId),
    c.env.DB.prepare(
      `SELECT s.id, s.bill_id, s.member_id, s.position, s.amount_cents, s.paid_at, s.idempotency_key
       FROM shares s
       INNER JOIN bills b ON b.id = s.bill_id
       WHERE b.home_id = ?
       ORDER BY s.position ASC`,
    ).bind(homeId),
    c.env.DB.prepare(
      `SELECT m.id AS member_id, m.name, COALESCE(SUM(s.amount_cents), 0) AS outstanding_cents
       FROM members m
       LEFT JOIN shares s ON s.member_id = m.id AND s.paid_at IS NULL
       WHERE m.home_id = ?
       GROUP BY m.id, m.name, m.seq
       ORDER BY m.seq ASC`,
    ).bind(homeId),
  ])

  const memberRows = (membersResult?.results ?? []) as MemberRow[]
  const billRows = (billsResult?.results ?? []) as BillRow[]
  const shareRows = (sharesResult?.results ?? []) as ShareRow[]
  const balanceRows = (balancesResult?.results ?? []) as BalanceRow[]

  const members = memberRows.map((m) => ({
    id: m.id,
    homeId: m.home_id,
    name: m.name,
  }))

  const sharesByBill = new Map<string, ShareResponse[]>()
  for (const s of shareRows) {
    const list = sharesByBill.get(s.bill_id) ?? []
    list.push({
      id: s.id,
      memberId: s.member_id,
      amountCents: s.amount_cents,
      paidAt: s.paid_at,
    })
    sharesByBill.set(s.bill_id, list)
  }

  const bills = billRows.map((b) => ({
    id: b.id,
    homeId: b.home_id,
    title: b.title,
    totalCents: b.total_cents,
    shares: sharesByBill.get(b.id) ?? [],
  }))

  const balances = balanceRows.map((b) => ({
    memberId: b.member_id,
    name: b.name,
    outstandingCents: Number(b.outstanding_cents),
  }))

  return c.json({
    id: home.id,
    name: home.name,
    members,
    bills,
    balances,
  })
})

app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id, name FROM homes WHERE id = ?')
    .bind(homeId)
    .first<HomeRow>()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const body = await parseJsonBody(c)
  if (!body || !isNonEmptyString(body.name)) {
    return c.json({ error: 'Invalid member name' }, 422)
  }

  const id = crypto.randomUUID()
  const name = body.name.trim()
  const createdAt = new Date().toISOString()

  await c.env.DB.prepare(
    `INSERT INTO members (id, home_id, name, seq, created_at)
     VALUES (?, ?, ?, COALESCE((SELECT MAX(seq) FROM members WHERE home_id = ?), 0) + 1, ?)`,
  )
    .bind(id, homeId, name, homeId, createdAt)
    .run()

  return c.json({ id, homeId, name }, 201)
})

app.get('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id, name FROM homes WHERE id = ?')
    .bind(homeId)
    .first<HomeRow>()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const [billsResult, sharesResult] = await c.env.DB.batch([
    c.env.DB.prepare(
      'SELECT id, home_id, title, total_cents, created_at FROM bills WHERE home_id = ? ORDER BY created_at ASC, rowid ASC',
    ).bind(homeId),
    c.env.DB.prepare(
      `SELECT s.id, s.bill_id, s.member_id, s.position, s.amount_cents, s.paid_at, s.idempotency_key
       FROM shares s
       INNER JOIN bills b ON b.id = s.bill_id
       WHERE b.home_id = ?
       ORDER BY s.position ASC`,
    ).bind(homeId),
  ])

  const billRows = (billsResult?.results ?? []) as BillRow[]
  const shareRows = (sharesResult?.results ?? []) as ShareRow[]

  const sharesByBill = new Map<string, ShareResponse[]>()
  for (const s of shareRows) {
    const list = sharesByBill.get(s.bill_id) ?? []
    list.push({
      id: s.id,
      memberId: s.member_id,
      amountCents: s.amount_cents,
      paidAt: s.paid_at,
    })
    sharesByBill.set(s.bill_id, list)
  }

  const bills = billRows.map((b) => ({
    id: b.id,
    homeId: b.home_id,
    title: b.title,
    totalCents: b.total_cents,
    shares: sharesByBill.get(b.id) ?? [],
  }))

  return c.json({ bills })
})

app.post('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id, name FROM homes WHERE id = ?')
    .bind(homeId)
    .first<HomeRow>()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const body = await parseJsonBody(c)
  if (!body || !isNonEmptyString(body.title) || !isPositiveInteger(body.totalCents)) {
    return c.json({ error: 'Invalid bill input' }, 422)
  }

  const membersResult = await c.env.DB.prepare(
    'SELECT id, home_id, name, seq FROM members WHERE home_id = ? ORDER BY seq ASC',
  )
    .bind(homeId)
    .all<MemberRow>()

  const members = membersResult.results
  if (members.length === 0) {
    return c.json({ error: 'Home has no members' }, 422)
  }

  const billId = crypto.randomUUID()
  const title = body.title.trim()
  const totalCents = body.totalCents
  const createdAt = new Date().toISOString()

  const memberCount = members.length
  const baseShare = Math.floor(totalCents / memberCount)
  const remainder = totalCents % memberCount

  const shares: ShareResponse[] = members.map((member, index) => ({
    id: crypto.randomUUID(),
    memberId: member.id,
    amountCents: baseShare + (index < remainder ? 1 : 0),
    paidAt: null,
  }))

  const statements = [
    c.env.DB.prepare(
      'INSERT INTO bills (id, home_id, title, total_cents, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(billId, homeId, title, totalCents, createdAt),
    ...shares.map((share, index) =>
      c.env.DB.prepare(
        `INSERT INTO shares (id, bill_id, member_id, position, amount_cents, paid_at, idempotency_key)
         VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
      ).bind(share.id, billId, share.memberId, index, share.amountCents),
    ),
  ]

  await c.env.DB.batch(statements)

  return c.json(
    {
      id: billId,
      homeId,
      title,
      totalCents,
      shares,
    },
    201,
  )
})

app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const idempotencyKey = c.req.header('Idempotency-Key')
  if (!isNonEmptyString(idempotencyKey)) {
    return c.json({ error: 'Idempotency-Key header is required' }, 400)
  }

  const billId = c.req.param('billId')
  const shareId = c.req.param('shareId')
  const now = new Date().toISOString()
  const trimmedKey = idempotencyKey.trim()

  const [, selectResult] = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE shares
       SET paid_at = ?, idempotency_key = ?
       WHERE id = ? AND bill_id = ? AND paid_at IS NULL`,
    ).bind(now, trimmedKey, shareId, billId),
    c.env.DB.prepare(
      `SELECT id, member_id, amount_cents, paid_at, idempotency_key
       FROM shares
       WHERE id = ? AND bill_id = ?`,
    ).bind(shareId, billId),
  ])

  const row = ((selectResult?.results ?? []) as ShareRow[])[0]
  if (!row) {
    return c.json({ error: 'Share not found' }, 404)
  }

  if (row.idempotency_key !== trimmedKey) {
    return c.json({ error: 'Share has already been paid with a different idempotency key' }, 409)
  }

  return c.json({
    id: row.id,
    memberId: row.member_id,
    amountCents: row.amount_cents,
    paidAt: row.paid_at,
  })
})

app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id, name FROM homes WHERE id = ?')
    .bind(homeId)
    .first<HomeRow>()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const balancesResult = await c.env.DB.prepare(
    `SELECT m.id AS member_id, m.name, COALESCE(SUM(s.amount_cents), 0) AS outstanding_cents
     FROM members m
     LEFT JOIN shares s ON s.member_id = m.id AND s.paid_at IS NULL
     WHERE m.home_id = ?
     GROUP BY m.id, m.name, m.seq
     ORDER BY m.seq ASC`,
  )
    .bind(homeId)
    .all<BalanceRow>()

  const balances = balancesResult.results.map((r) => ({
    memberId: r.member_id,
    name: r.name,
    outstandingCents: Number(r.outstanding_cents),
  }))

  return c.json({ balances })
})

app.notFound((c) => c.json({ error: 'Not found' }, 404))

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'Internal server error' }, 500)
})

export default app
