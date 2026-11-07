import { createFileRoute } from '@tanstack/react-router'
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'

export const Route = createFileRoute('/')({
  component: BillSplitterPage,
})

type HomeSummary = {
  id: string
  name: string
}

type Member = {
  id: string
  homeId: string
  name: string
}

type Share = {
  id: string
  memberId: string
  amountCents: number
  paidAt: string | null
}

type Bill = {
  id: string
  homeId: string
  title: string
  totalCents: number
  shares: Share[]
}

type Balance = {
  memberId: string
  name: string
  outstandingCents: number
}

type HomeDetailsResponse = {
  id: string
  name: string
  members: Member[]
  bills: Bill[]
  balances?: Balance[]
}

type ApiErrorResponse = {
  error?: string
}

function formatCents(cents: number): string {
  const dollars = (cents / 100).toFixed(2)
  return `$${dollars} (${cents}¢)`
}

function formatPaidAt(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }
  return date.toLocaleString()
}

async function apiRequest<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST'
    body?: unknown
    headers?: Record<string, string>
  } = {},
): Promise<{ ok: true; status: number; data: T } | { ok: false; status: number; error: string }> {
  try {
    const response = await fetch(path, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    })

    const rawText = await response.text()
    let parsed: unknown = null
    if (rawText) {
      try {
        parsed = JSON.parse(rawText)
      } catch {
        parsed = null
      }
    }

    if (!response.ok) {
      const errObj = parsed as ApiErrorResponse | null
      const message =
        errObj && typeof errObj.error === 'string' && errObj.error.trim().length > 0
          ? errObj.error
          : `Request failed with status ${response.status}`
      return { ok: false, status: response.status, error: message }
    }

    if (parsed === null) {
      return {
        ok: false,
        status: response.status,
        error: 'Received malformed JSON response from server',
      }
    }

    return { ok: true, status: response.status, data: parsed as T }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Network error while communicating with the API'
    return { ok: false, status: 0, error: message }
  }
}

function BillSplitterPage() {
  const [homes, setHomes] = useState<HomeSummary[]>([])
  const [selectedHomeId, setSelectedHomeId] = useState<string | null>(null)
  const [activeHome, setActiveHome] = useState<HomeDetailsResponse | null>(null)
  const [balances, setBalances] = useState<Balance[]>([])

  const [loadingHomes, setLoadingHomes] = useState<boolean>(true)
  const [loadingHomeDetails, setLoadingHomeDetails] = useState<boolean>(false)

  const [fetchError, setFetchError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [shareErrors, setShareErrors] = useState<Record<string, string>>({})

  const [newHomeName, setNewHomeName] = useState<string>('')
  const [creatingHome, setCreatingHome] = useState<boolean>(false)

  const [newMemberName, setNewMemberName] = useState<string>('')
  const [addingMember, setAddingMember] = useState<boolean>(false)

  const [billTitle, setBillTitle] = useState<string>('')
  const [billTotalCentsInput, setBillTotalCentsInput] = useState<string>('')
  const [creatingBill, setCreatingBill] = useState<boolean>(false)

  const [payingShareIds, setPayingShareIds] = useState<Record<string, boolean>>({})
  const idempotencyKeysRef = useRef<Record<string, string>>({})

  const loadHomes = useCallback(async (preferredHomeId?: string) => {
    setLoadingHomes(true)
    setFetchError(null)

    const result = await apiRequest<{ homes: HomeSummary[] }>('/api/homes')
    if (!result.ok) {
      setFetchError(result.error)
      setLoadingHomes(false)
      return
    }

    const fetchedHomes = result.data.homes ?? []
    setHomes(fetchedHomes)
    setLoadingHomes(false)

    if (preferredHomeId) {
      setSelectedHomeId(preferredHomeId)
    } else {
      setSelectedHomeId((prev) => {
        if (prev && fetchedHomes.some((h) => h.id === prev)) {
          return prev
        }
        return fetchedHomes[0]?.id ?? null
      })
    }
  }, [])

  const loadActiveHome = useCallback(async (homeId: string) => {
    setLoadingHomeDetails(true)
    setFetchError(null)

    const [homeResult, balancesResult] = await Promise.all([
      apiRequest<HomeDetailsResponse>(`/api/homes/${homeId}`),
      apiRequest<{ balances: Balance[] }>(`/api/homes/${homeId}/balances`),
    ])

    if (!homeResult.ok) {
      setFetchError(homeResult.error)
      setLoadingHomeDetails(false)
      return
    }

    if (!balancesResult.ok) {
      setFetchError(balancesResult.error)
      setLoadingHomeDetails(false)
      return
    }

    setActiveHome(homeResult.data)
    setBalances(balancesResult.data.balances)
    setLoadingHomeDetails(false)
  }, [])

  useEffect(() => {
    void loadHomes()
  }, [loadHomes])

  useEffect(() => {
    if (selectedHomeId) {
      void loadActiveHome(selectedHomeId)
    } else {
      setActiveHome(null)
      setBalances([])
    }
  }, [selectedHomeId, loadActiveHome])

  async function handleCreateHome(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setActionError(null)

    const trimmed = newHomeName.trim()
    if (!trimmed) {
      setActionError('Please enter a non-empty home name.')
      return
    }

    setCreatingHome(true)
    const result = await apiRequest<HomeSummary>('/api/homes', {
      method: 'POST',
      body: { name: trimmed },
    })
    setCreatingHome(false)

    if (!result.ok) {
      setActionError(result.error)
      return
    }

    setNewHomeName('')
    setHomes((prev) => [...prev, result.data])
    setSelectedHomeId(result.data.id)
  }

  async function handleAddMember(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!selectedHomeId) return
    setActionError(null)

    const trimmed = newMemberName.trim()
    if (!trimmed) {
      setActionError('Please enter a non-empty member name.')
      return
    }

    setAddingMember(true)
    const result = await apiRequest<Member>(`/api/homes/${selectedHomeId}/members`, {
      method: 'POST',
      body: { name: trimmed },
    })
    setAddingMember(false)

    if (!result.ok) {
      setActionError(result.error)
      return
    }

    setNewMemberName('')
    await loadActiveHome(selectedHomeId)
  }

  async function handleCreateBill(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!selectedHomeId) return
    setActionError(null)

    const trimmedTitle = billTitle.trim()
    if (!trimmedTitle) {
      setActionError('Please enter a bill title.')
      return
    }

    const trimmedAmount = billTotalCentsInput.trim()
    const parsedCents = Number(trimmedAmount)
    if (!trimmedAmount || !Number.isInteger(parsedCents) || parsedCents <= 0) {
      setActionError(
        'Total amount must be a positive whole number of cents (e.g., 1000 for $10.00).',
      )
      return
    }

    setCreatingBill(true)
    const result = await apiRequest<Bill>(`/api/homes/${selectedHomeId}/bills`, {
      method: 'POST',
      body: { title: trimmedTitle, totalCents: parsedCents },
    })
    setCreatingBill(false)

    if (!result.ok) {
      setActionError(result.error)
      return
    }

    setBillTitle('')
    setBillTotalCentsInput('')
    await loadActiveHome(selectedHomeId)
  }

  async function handlePayShare(billId: string, shareId: string) {
    if (payingShareIds[shareId]) return

    setActionError(null)
    setShareErrors((prev) => {
      const next = { ...prev }
      delete next[shareId]
      return next
    })

    let idempotencyKey = idempotencyKeysRef.current[shareId]
    if (!idempotencyKey) {
      idempotencyKey = crypto.randomUUID()
      idempotencyKeysRef.current[shareId] = idempotencyKey
    }

    setPayingShareIds((prev) => ({ ...prev, [shareId]: true }))

    const result = await apiRequest<Share>(`/api/bills/${billId}/shares/${shareId}/pay`, {
      method: 'POST',
      headers: {
        'Idempotency-Key': idempotencyKey,
      },
    })

    setPayingShareIds((prev) => ({ ...prev, [shareId]: false }))

    if (!result.ok) {
      // Keep the share unpaid and display error message
      setShareErrors((prev) => ({ ...prev, [shareId]: result.error }))
      setActionError(`Payment failed: ${result.error}`)
      return
    }

    // Update the share state immediately and refresh balances
    setActiveHome((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        bills: prev.bills.map((bill) =>
          bill.id === billId
            ? {
                ...bill,
                shares: bill.shares.map((share) => (share.id === shareId ? result.data : share)),
              }
            : bill,
        ),
      }
    })

    if (selectedHomeId) {
      const balancesResult = await apiRequest<{ balances: Balance[] }>(
        `/api/homes/${selectedHomeId}/balances`,
      )
      if (balancesResult.ok) {
        setBalances(balancesResult.data.balances)
      }
    }
  }

  const memberNameById = new Map<string, string>()
  if (activeHome) {
    for (const member of activeHome.members) {
      memberNameById.set(member.id, member.name)
    }
  }

  const previewCents = Number(billTotalCentsInput.trim())
  const isValidPreviewCents =
    billTotalCentsInput.trim().length > 0 && Number.isInteger(previewCents) && previewCents > 0

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: '#f8fafc',
        color: '#0f172a',
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        padding: '24px 16px 48px',
      }}
    >
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <header
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 16,
            marginBottom: 24,
            paddingBottom: 16,
            borderBottom: '1px solid #e2e8f0',
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700, color: '#0f172a' }}>
              Shared Home Bill Splitter
            </h1>
            <p style={{ margin: '4px 0 0', fontSize: 14, color: '#475569' }}>
              Create a home, add members in order, split bills in exact cents, and pay individual
              shares safely.
            </p>
          </div>
          {selectedHomeId && (
            <button
              type="button"
              onClick={() => void loadActiveHome(selectedHomeId)}
              disabled={loadingHomeDetails}
              style={{
                padding: '8px 14px',
                borderRadius: 6,
                border: '1px solid #cbd5e1',
                backgroundColor: '#ffffff',
                color: '#1e293b',
                fontSize: 14,
                fontWeight: 500,
                cursor: loadingHomeDetails ? 'not-allowed' : 'pointer',
              }}
            >
              {loadingHomeDetails ? 'Refreshing...' : 'Refresh Home Data'}
            </button>
          )}
        </header>

        {/* Global Fetch Error Banner */}
        {fetchError && (
          <div
            role="alert"
            style={{
              backgroundColor: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: 8,
              padding: '14px 16px',
              marginBottom: 20,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
              color: '#991b1b',
            }}
          >
            <div>
              <strong style={{ display: 'block', fontSize: 14 }}>Unable to load data</strong>
              <span style={{ fontSize: 14 }}>{fetchError}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                if (selectedHomeId) {
                  void loadActiveHome(selectedHomeId)
                } else {
                  void loadHomes()
                }
              }}
              style={{
                padding: '6px 12px',
                borderRadius: 6,
                border: '1px solid #f87171',
                backgroundColor: '#ffffff',
                color: '#991b1b',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Retry
            </button>
          </div>
        )}

        {/* Action / Validation / Payment Error Banner */}
        {actionError && (
          <div
            role="alert"
            style={{
              backgroundColor: '#fff1f2',
              border: '1px solid #fda4af',
              borderRadius: 8,
              padding: '12px 16px',
              marginBottom: 20,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
              color: '#9f1239',
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 500 }}>{actionError}</span>
            <button
              type="button"
              onClick={() => setActionError(null)}
              style={{
                padding: '4px 10px',
                borderRadius: 4,
                border: '1px solid #fda4af',
                backgroundColor: '#ffffff',
                color: '#9f1239',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Home Selector & Creation Section */}
        <section
          style={{
            backgroundColor: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: 10,
            padding: 20,
            marginBottom: 24,
            boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04)',
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: 20,
              alignItems: 'end',
            }}
          >
            <div>
              <label
                htmlFor="home-select"
                style={{
                  display: 'block',
                  fontSize: 13,
                  fontWeight: 600,
                  color: '#334155',
                  marginBottom: 6,
                }}
              >
                Active Home
              </label>
              {loadingHomes ? (
                <div style={{ fontSize: 14, color: '#64748b', padding: '8px 0' }}>
                  Loading homes...
                </div>
              ) : homes.length === 0 ? (
                <div style={{ fontSize: 14, color: '#64748b', padding: '8px 0' }}>
                  No homes yet — create one to get started
                </div>
              ) : (
                <select
                  id="home-select"
                  value={selectedHomeId ?? ''}
                  onChange={(e) => setSelectedHomeId(e.target.value || null)}
                  style={{
                    width: '100%',
                    padding: '9px 12px',
                    borderRadius: 6,
                    border: '1px solid #cbd5e1',
                    fontSize: 14,
                    backgroundColor: '#ffffff',
                    color: '#0f172a',
                  }}
                >
                  {homes.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <form
              onSubmit={(e) => void handleCreateHome(e)}
              style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}
            >
              <div style={{ flex: 1 }}>
                <label
                  htmlFor="new-home-name"
                  style={{
                    display: 'block',
                    fontSize: 13,
                    fontWeight: 600,
                    color: '#334155',
                    marginBottom: 6,
                  }}
                >
                  Create a New Home
                </label>
                <input
                  id="new-home-name"
                  type="text"
                  placeholder="e.g., Flat 4B"
                  value={newHomeName}
                  onChange={(e) => setNewHomeName(e.target.value)}
                  disabled={creatingHome}
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    padding: '9px 12px',
                    borderRadius: 6,
                    border: '1px solid #cbd5e1',
                    fontSize: 14,
                  }}
                />
              </div>
              <button
                type="submit"
                disabled={creatingHome}
                style={{
                  padding: '9px 16px',
                  borderRadius: 6,
                  border: 'none',
                  backgroundColor: '#2563eb',
                  color: '#ffffff',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: creatingHome ? 'not-allowed' : 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {creatingHome ? 'Creating...' : 'Create Home'}
              </button>
            </form>
          </div>
        </section>

        {/* Active Home Content */}
        {loadingHomeDetails && !activeHome ? (
          <div
            style={{
              backgroundColor: '#ffffff',
              border: '1px solid #e2e8f0',
              borderRadius: 10,
              padding: 32,
              textAlign: 'center',
              color: '#475569',
              fontSize: 15,
            }}
          >
            Loading home details, bills, and balances...
          </div>
        ) : !activeHome ? (
          <div
            style={{
              backgroundColor: '#ffffff',
              border: '1px solid #e2e8f0',
              borderRadius: 10,
              padding: 32,
              textAlign: 'center',
              color: '#64748b',
              fontSize: 15,
            }}
          >
            Select or create a home above to manage members and split bills.
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
              gap: 24,
              alignItems: 'start',
            }}
          >
            {/* Left Column: Members & Balances */}
            <section
              style={{
                backgroundColor: '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: 10,
                padding: 20,
                boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  marginBottom: 16,
                }}
              >
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
                  Members & Balances ({activeHome.members.length})
                </h2>
                <span style={{ fontSize: 12, color: '#64748b' }}>Ordered by addition</span>
              </div>

              <form
                onSubmit={(e) => void handleAddMember(e)}
                style={{ display: 'flex', gap: 8, marginBottom: 18 }}
              >
                <label htmlFor="new-member-name" style={{ display: 'none' }}>
                  Member Name
                </label>
                <input
                  id="new-member-name"
                  type="text"
                  placeholder="Add member name (e.g., Asha)"
                  value={newMemberName}
                  onChange={(e) => setNewMemberName(e.target.value)}
                  disabled={addingMember}
                  style={{
                    flex: 1,
                    padding: '8px 12px',
                    borderRadius: 6,
                    border: '1px solid #cbd5e1',
                    fontSize: 14,
                  }}
                />
                <button
                  type="submit"
                  disabled={addingMember}
                  style={{
                    padding: '8px 14px',
                    borderRadius: 6,
                    border: 'none',
                    backgroundColor: '#0f172a',
                    color: '#ffffff',
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: addingMember ? 'not-allowed' : 'pointer',
                  }}
                >
                  {addingMember ? 'Adding...' : 'Add Member'}
                </button>
              </form>

              {balances.length === 0 ? (
                <div
                  style={{
                    padding: 16,
                    borderRadius: 8,
                    backgroundColor: '#f8fafc',
                    border: '1px dashed #cbd5e1',
                    color: '#64748b',
                    fontSize: 14,
                    textAlign: 'center',
                  }}
                >
                  Add at least one member before creating a bill.
                </div>
              ) : (
                <ul
                  style={{
                    listStyle: 'none',
                    margin: 0,
                    padding: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  {balances.map((item, idx) => (
                    <li
                      key={item.memberId}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '10px 12px',
                        borderRadius: 8,
                        backgroundColor: '#f8fafc',
                        border: '1px solid #e2e8f0',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: 22,
                            height: 22,
                            borderRadius: '50%',
                            backgroundColor: '#e2e8f0',
                            color: '#334155',
                            fontSize: 12,
                            fontWeight: 600,
                          }}
                        >
                          {idx + 1}
                        </span>
                        <span style={{ fontWeight: 600, fontSize: 14 }}>{item.name}</span>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <span
                          style={{
                            fontSize: 13,
                            fontWeight: 700,
                            color: item.outstandingCents > 0 ? '#b45309' : '#15803d',
                          }}
                        >
                          {item.outstandingCents > 0
                            ? `Owes ${formatCents(item.outstandingCents)}`
                            : 'Settled ($0.00)'}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Right Column: Create Bill + Bills & Shares List */}
            <section
              style={{
                backgroundColor: '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: 10,
                padding: 20,
                boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04)',
              }}
            >
              <h2 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 700 }}>
                Split a New Bill
              </h2>

              <form
                onSubmit={(e) => void handleCreateBill(e)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  paddingBottom: 20,
                  marginBottom: 20,
                  borderBottom: '1px solid #e2e8f0',
                }}
              >
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ flex: '1 1 180px' }}>
                    <label
                      htmlFor="bill-title"
                      style={{
                        display: 'block',
                        fontSize: 12,
                        fontWeight: 600,
                        color: '#475569',
                        marginBottom: 4,
                      }}
                    >
                      Bill Title
                    </label>
                    <input
                      id="bill-title"
                      type="text"
                      placeholder="e.g., Electricity"
                      value={billTitle}
                      onChange={(e) => setBillTitle(e.target.value)}
                      disabled={creatingBill}
                      style={{
                        width: '100%',
                        boxSizing: 'border-box',
                        padding: '8px 12px',
                        borderRadius: 6,
                        border: '1px solid #cbd5e1',
                        fontSize: 14,
                      }}
                    />
                  </div>

                  <div style={{ flex: '1 1 160px' }}>
                    <label
                      htmlFor="bill-total-cents"
                      style={{
                        display: 'block',
                        fontSize: 12,
                        fontWeight: 600,
                        color: '#475569',
                        marginBottom: 4,
                      }}
                    >
                      Total Amount (in cents)
                    </label>
                    <input
                      id="bill-total-cents"
                      type="number"
                      step={1}
                      placeholder="e.g., 1000 ($10.00)"
                      value={billTotalCentsInput}
                      onChange={(e) => setBillTotalCentsInput(e.target.value)}
                      disabled={creatingBill}
                      style={{
                        width: '100%',
                        boxSizing: 'border-box',
                        padding: '8px 12px',
                        borderRadius: 6,
                        border: '1px solid #cbd5e1',
                        fontSize: 14,
                      }}
                    />
                  </div>
                </div>

                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 12,
                  }}
                >
                  <span style={{ fontSize: 12, color: '#64748b' }}>
                    {isValidPreviewCents
                      ? `Splitting ${formatCents(previewCents)} across ${activeHome.members.length} member(s)`
                      : 'Enter whole cents (100 cents = $1.00)'}
                  </span>
                  <button
                    type="submit"
                    disabled={creatingBill}
                    style={{
                      padding: '8px 16px',
                      borderRadius: 6,
                      border: 'none',
                      backgroundColor: '#2563eb',
                      color: '#ffffff',
                      fontSize: 14,
                      fontWeight: 600,
                      cursor: creatingBill ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {creatingBill ? 'Splitting Bill...' : 'Add & Split Bill'}
                  </button>
                </div>
              </form>

              <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700 }}>
                Bills & Member Shares ({activeHome.bills.length})
              </h3>

              {activeHome.bills.length === 0 ? (
                <div
                  style={{
                    padding: 20,
                    borderRadius: 8,
                    backgroundColor: '#f8fafc',
                    border: '1px dashed #cbd5e1',
                    color: '#64748b',
                    fontSize: 14,
                    textAlign: 'center',
                  }}
                >
                  No bills yet for this home.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {activeHome.bills.map((bill) => {
                    const paidCount = bill.shares.filter((s) => s.paidAt !== null).length
                    return (
                      <div
                        key={bill.id}
                        style={{
                          border: '1px solid #e2e8f0',
                          borderRadius: 8,
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            backgroundColor: '#f8fafc',
                            padding: '12px 14px',
                            borderBottom: '1px solid #e2e8f0',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                        >
                          <div>
                            <strong style={{ fontSize: 15, color: '#0f172a' }}>{bill.title}</strong>
                            <span
                              style={{
                                display: 'block',
                                fontSize: 12,
                                color: '#64748b',
                                marginTop: 2,
                              }}
                            >
                              {paidCount} of {bill.shares.length} shares paid
                            </span>
                          </div>
                          <span
                            style={{
                              fontSize: 15,
                              fontWeight: 700,
                              color: '#0f172a',
                            }}
                          >
                            {formatCents(bill.totalCents)}
                          </span>
                        </div>

                        <ul
                          style={{
                            listStyle: 'none',
                            margin: 0,
                            padding: 0,
                          }}
                        >
                          {bill.shares.map((share, idx) => {
                            const memberName =
                              memberNameById.get(share.memberId) ?? `Member ${idx + 1}`
                            const isPaid = share.paidAt !== null
                            const isPaying = Boolean(payingShareIds[share.id])
                            const shareError = shareErrors[share.id]

                            return (
                              <li
                                key={share.id}
                                style={{
                                  padding: '10px 14px',
                                  borderTop: idx === 0 ? 'none' : '1px solid #f1f5f9',
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: 6,
                                }}
                              >
                                <div
                                  style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    gap: 12,
                                  }}
                                >
                                  <div>
                                    <span style={{ fontWeight: 600, fontSize: 14 }}>
                                      {memberName}
                                    </span>
                                    <span
                                      style={{
                                        marginLeft: 8,
                                        fontSize: 13,
                                        color: '#475569',
                                      }}
                                    >
                                      {formatCents(share.amountCents)}
                                    </span>
                                  </div>

                                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                    {isPaid && share.paidAt ? (
                                      <span
                                        style={{
                                          display: 'inline-block',
                                          padding: '4px 10px',
                                          borderRadius: 999,
                                          backgroundColor: '#dcfce7',
                                          color: '#166534',
                                          fontSize: 12,
                                          fontWeight: 600,
                                        }}
                                        title={`Paid at ${share.paidAt}`}
                                      >
                                        Paid ({formatPaidAt(share.paidAt)})
                                      </span>
                                    ) : (
                                      <>
                                        <span
                                          style={{
                                            display: 'inline-block',
                                            padding: '3px 8px',
                                            borderRadius: 999,
                                            backgroundColor: '#fef3c7',
                                            color: '#92400e',
                                            fontSize: 12,
                                            fontWeight: 600,
                                          }}
                                        >
                                          Unpaid
                                        </span>
                                        <button
                                          type="button"
                                          disabled={isPaying}
                                          onClick={() => void handlePayShare(bill.id, share.id)}
                                          style={{
                                            padding: '6px 12px',
                                            borderRadius: 6,
                                            border: 'none',
                                            backgroundColor: isPaying ? '#94a3b8' : '#16a34a',
                                            color: '#ffffff',
                                            fontSize: 13,
                                            fontWeight: 600,
                                            cursor: isPaying ? 'not-allowed' : 'pointer',
                                          }}
                                        >
                                          {isPaying ? 'Paying...' : 'Pay Share'}
                                        </button>
                                      </>
                                    )}
                                  </div>
                                </div>

                                {shareError && !isPaid && (
                                  <div
                                    role="alert"
                                    style={{
                                      fontSize: 12,
                                      color: '#b91c1c',
                                      backgroundColor: '#fef2f2',
                                      padding: '6px 10px',
                                      borderRadius: 6,
                                      border: '1px solid #fecaca',
                                    }}
                                  >
                                    Could not mark share as paid: {shareError}
                                  </div>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  )
}
