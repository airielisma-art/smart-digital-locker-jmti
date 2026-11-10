import { useEffect, useMemo, useState } from 'react'
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { QRCodeCanvas } from 'qrcode.react'
import { jsPDF } from 'jspdf'
import { getDocs, query, collection, where, orderBy, onSnapshot, Timestamp, setDoc, doc } from 'firebase/firestore'
import { db } from './firebase'
import { AuthProvider, getProfile, useAuth } from './auth'
import { closeLockerForBooking, createCheckout, ensurePendingBooking, getReceipt, releaseExpiredLocker, submitContact, submitReview, verifyAccessCode, reconcileLockerBookings } from './api'
import { ensureDemoLockers, getDemoLockers, getDemoReviews, isDemoModeEnabled, syncExpiredDemoRentals, getActiveDemoRentalForUser, submitDemoContact, submitDemoReview } from './demo'
import type { Locker, Rental } from './types'

const APP_URL = import.meta.env.VITE_PUBLIC_APP_URL || window.location.origin
const DEMO_BADGE = isDemoModeEnabled() ? 'DEMO MODE' : 'PRODUCTION'

const RM2_PER_HOUR = 2

// Cache for active bookings to speed up availability checks
let cachedActiveBookings: Map<string, any> = new Map()
let lastBookingCheckTime = 0
const BOOKING_CACHE_TTL = 5000 // 5 seconds

function normalizeLockerStatus(value: string | undefined) {
  return String(value || 'AVAILABLE').trim().toUpperCase()
}

function formatCurrency(value: number) {
  return `RM ${Number(value).toFixed(2)}`
}

function formatDateTime(date: Date | { seconds: number } | undefined | null) {
  if (!date) return '—'

  const timestamp = typeof date === 'object' && 'seconds' in date ? date.seconds * 1000 : new Date(date).getTime()
  return new Date(timestamp).toLocaleString('en-MY', { hour12: false })
}

function parseFireStoreDate(value: unknown): Date | null {
  if (!value) return null

  if (typeof value === 'object' && value !== null) {
    if ('toDate' in value && typeof (value as any).toDate === 'function') {
      return (value as any).toDate()
    }
    if ('seconds' in value && typeof (value as any).seconds === 'number') {
      return new Date((value as any).seconds * 1000)
    }
  }

  const next = new Date(String(value))
  return Number.isNaN(next.getTime()) ? null : next
}

function isActivePaidBookingForUser(booking: any, uid: string) {
  if (!booking || !uid) return false
  if (String(booking.userId || '') !== String(uid)) return false

  const paymentStatus = String(booking.paymentStatus || '').toUpperCase()
  if (paymentStatus !== 'PAID') return false

  const start = parseFireStoreDate(booking.rentalStart)
  const end = parseFireStoreDate(booking.rentalEnd)
  if (!start || !end) return false

  const now = Date.now()
  return start.getTime() <= now && end.getTime() > now
}

/** Check if a locker has an active rental based on locker document */
function hasActiveRental(locker: any) {
  return Boolean(
    locker?.isOccupied === true &&
    locker?.bookingId &&
    locker?.rentalEnd &&
    new Date(locker.rentalEnd).getTime() > Date.now()
  )
}

/** Check if locker booking exists in cache (for duplicate prevention) */
function hasActiveBookingInCache(lockerId: string) {
  for (const booking of cachedActiveBookings.values()) {
    if (booking.lockerId === lockerId && booking.paymentStatus === 'PAID') {
      const rentalEnd = booking.rentalEnd ? new Date(booking.rentalEnd).getTime() : 0
      if (rentalEnd > Date.now()) {
        return true
      }
    }
  }
  return false
}

function hasExpiredRental(locker: any) {
  return Boolean(
    locker?.rentalEnd &&
    new Date(locker.rentalEnd).getTime() <= Date.now()
  )
}

function isLockerBookable(locker: any) {
  // First check: locker document must not have an active rental.
  if (hasActiveRental(locker)) return false

  // Second check: verify against cached bookings as the Firestore source of truth.
  if (hasActiveBookingInCache(locker.id)) return false

  return true
}

function getEffectiveLockerStatus(item: any) {
  const current = normalizeLockerStatus(item?.status)

  // Active linked locker rental wins first.
  if (hasActiveRental(item)) return 'BOOKED'

  // Booking collection is the failsafe source of truth for active rentals.
  if (hasActiveBookingInCache(item.id)) return 'BOOKED'

  // Expired but not active: allow the locker to return to AVAILABLE.
  if (hasExpiredRental(item)) return 'AVAILABLE'

  // Do not downgrade OPEN/CLOSED/BOOKED to AVAILABLE. Preserve the true state. 
  return current
}

function downloadReceiptPdf(receipt: any) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 42
  const contentWidth = pageWidth - margin * 2
  const bookingId = receipt?.bookingId || receipt?.id || receipt?.receiptNumber || 'receipt'
  const accessCode = receipt?.accessCode || receipt?.codes?.[0] || '—'
  const customerName = receipt?.customerName || 'Customer'
  const customerEmail = receipt?.customerEmail || '—'
  const lockerNumber = Number(receipt?.lockerNumber || 0)
  const durationHours = Number(receipt?.durationHours || receipt?.rentalHours || 0)
  const pricePerHour = Number(receipt?.pricePerHour || RM2_PER_HOUR)
  const totalPrice = Number(receipt?.amount || receipt?.totalPrice || 0)
  const status = String(receipt?.paymentStatus || 'PAID')
  const paymentDateRaw = receipt?.receiptDate || receipt?.paymentDate || new Date().toISOString()
  const startDate = receipt?.startTime ? new Date(receipt.startTime?.seconds ? receipt.startTime.seconds * 1000 : receipt.startTime) : new Date()
  const endDate = receipt?.expiryTime ? new Date(receipt.expiryTime?.seconds ? receipt.expiryTime.seconds * 1000 : receipt.expiryTime) : new Date(startDate.getTime() + durationHours * 60 * 60 * 1000)

  const formatShortDate = (value: Date) => new Intl.DateTimeFormat('en-MY', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value)

  const drawDivider = (y: number) => {
    doc.setDrawColor(80, 96, 112)
    doc.line(margin, y, pageWidth - margin, y)
  }

  doc.setFillColor(15, 52, 90)
  doc.rect(0, 0, pageWidth, 74, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(22)
  doc.text('SMART DIGITAL LOCKER', margin, 30)
  doc.setFontSize(11)
  doc.text('PAYMENT RECEIPT', margin, 52)

  let y = 98
  doc.setTextColor(17, 24, 39)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.text('Payment Status', margin, y)
  doc.setFont('helvetica', 'normal')
  doc.text(String(status).toUpperCase(), margin + 130, y)
  y += 22

  drawDivider(y)
  y += 20

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.text('CUSTOMER INFORMATION', margin, y)
  y += 18
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.text(`Name         : ${customerName}`, margin, y)
  y += 18
  doc.text(`Email        : ${customerEmail}`, margin, y)
  y += 22

  drawDivider(y)
  y += 20

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.text('LOCKER INFORMATION', margin, y)
  y += 18
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.text(`Locker       : Locker ${String(lockerNumber).padStart(2, '0')}`, margin, y)
  y += 18
  doc.text(`Duration     : ${durationHours} ${durationHours === 1 ? 'Hour' : 'Hours'}`, margin, y)
  y += 18
  doc.text(`Price        : ${formatCurrency(pricePerHour)} / hour`, margin, y)
  y += 18
  doc.text(`Rental Start : ${formatShortDate(startDate)}`, margin, y)
  y += 18
  doc.text(`Rental End   : ${formatShortDate(endDate)}`, margin, y)
  y += 22

  drawDivider(y)
  y += 20

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.text('PAYMENT SUMMARY', margin, y)
  y += 18
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.text(`Rental       : ${formatCurrency(totalPrice)}`, margin, y)
  y += 18
  doc.setFont('helvetica', 'bold')
  doc.text(`Total        : ${formatCurrency(totalPrice)}`, margin, y)
  y += 18
  doc.setFont('helvetica', 'normal')
  doc.text(`Payment Date : ${formatShortDate(new Date(paymentDateRaw))}`, margin, y)
  y += 22

  drawDivider(y)
  y += 20

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.text('ACCESS CODE', margin, y)
  y += 18

  const accessBoxY = y + 8
  doc.setFillColor(239, 246, 255)
  doc.roundedRect(margin, accessBoxY, contentWidth, 56, 8, 8, 'F')
  doc.setTextColor(9, 30, 61)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(24)
  doc.text(String(accessCode), margin + 18, accessBoxY + 34)
  doc.setTextColor(17, 24, 39)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.text('Use this code to access your locker during the rental period.', margin + 18, accessBoxY + 46)

  y = accessBoxY + 80
  drawDivider(y)
  y += 24

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.text('THANK YOU FOR USING SMART DIGITAL LOCKER', margin + 60, y)
  doc.setDrawColor(41, 98, 255)

  doc.save(`smart-digital-locker-receipt-${bookingId}.pdf`)
}

function Layout() {
  const { user, logout } = useAuth()
  const [open, setOpen] = useState(false)

  // Reconcile locker bookings only after authentication is present.
  useEffect(() => {
    if (!user) return

    let mounted = true
    async function reconcile() {
      try {
        if (mounted) {
          const result = await reconcileLockerBookings()
          if (result.updated > 0) {
            console.log(`[APP] Reconciled ${result.updated} locker bookings`)
          }
        }
      } catch (e: any) {
        console.error('[APP] Reconciliation error:', e?.message)
      }
    }
    void reconcile()
    return () => {
      mounted = false
    }
  }, [user])

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand"><span className="brand-dot" />SMART<span>LOCKER</span></Link>
        <div className="topbar-badges">
          <span className="demo-badge">{DEMO_BADGE}</span>
        </div>
        <button className="menu-btn" onClick={() => setOpen(v => !v)} aria-label="Menu">☰</button>
        <nav className={open ? 'nav open' : 'nav'} onClick={() => setOpen(false)}>
          <NavLink to="/">Home</NavLink>
          <NavLink to="/rent">Rent Locker</NavLink>
          <NavLink to="/my-locker">My Locker</NavLink>
          <NavLink to="/location">Location</NavLink>
          <NavLink to="/reviews">Reviews</NavLink>
          <NavLink to="/contact">Contact</NavLink>
          {user ? <button className="nav-logout" onClick={logout}>Log out</button> : <NavLink to="/login">Login / Sign Up</NavLink>}
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/rent" element={<Rent />} />
          <Route path="/checkout" element={<Checkout />} />
          <Route path="/checkout-success" element={<Success />} />
          <Route path="/my-locker" element={<Protected><MyLocker /></Protected>} />
          <Route path="/location" element={<LocationPage />} />
          <Route path="/reviews" element={<Reviews />} />
          <Route path="/contact" element={<Contact />} />
          <Route path="/login" element={<Login />} />
          <Route path="/admin" element={<Protected><Admin /></Protected>} />
        </Routes>
      </main>
      <footer><div><b>SMARTLOCKER</b><span> Secure. Simple. Smart.</span></div><small>© 2026 Smart Digital Locker</small></footer>
    </div>
  )
}

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <div className="center"><Spinner /></div>
  return user ? <>{children}</> : <NavigateLogin />
}

function NavigateLogin() {
  return <div className="center"><h2>Login required</h2><Link className="btn primary" to="/login">Go to Login</Link></div>
}

function Spinner() { return <div className="spinner" /> }

function Home() {
  return (
    <div>
      <section className="hero">
        <div>
          <div className="eyebrow">24/7 SMART STORAGE</div>
          <h1>KEEP YOUR<br /><em>THINGS SAFE</em></h1>
          <p>Rent a locker in minutes, complete a demo payment, and get your access code ready to use.</p>
          <div className="actions">
            <Link className="btn primary" to="/rent">Rent a Locker →</Link>
            <Link className="btn ghost" to="/my-locker">My Locker</Link>
          </div>
        </div>
        <div className="locker-visual"><div className="scanline" />{[1, 2, 3, 4, 5, 6].map(i => <div className="locker-cell" key={i}><span>{String(i).padStart(2, '0')}</span><i>●</i></div>)}</div>
      </section>
      <section className="section">
        <div className="section-title"><span>HOW IT WORKS</span><h2>Simple steps, no hassle.</h2></div>
        <div className="steps">{[['01', 'Choose', 'Pick your locker and the rental length you need.'], ['02', 'Pay', 'Review your booking and complete the demo payment.'], ['03', 'Confirm', 'Get your receipt and your single access code.'], ['04', 'Unlock', 'Use your code in My Locker when you need it.']].map(([n, t, d]) => <div className="step" key={n}><b>{n}</b><h3>{t}</h3><p>{d}</p></div>)}</div>
      </section>
      <section className="section split">
        <div>
          <div className="eyebrow">WHY SMARTLOCKER</div>
          <h2>Fast, easy, and secure access.</h2>
          <p>Each rental is linked to one locker, one customer, and one access code. Your rental ends automatically when the time is up.</p>
          <Link className="text-link" to="/rent">Find a locker →</Link>
        </div>
        <div className="stat-card"><strong>08</strong><span>SMART LOCKERS</span><strong>24/7</strong><span>SELF-SERVICE</span></div>
      </section>
    </div>
  )
}

async function loadLockers(): Promise<Locker[]> {
  if (isDemoModeEnabled()) {
    return ensureDemoLockers().map(l => ({ id: l.id, lockerNumber: l.lockerNumber, status: l.status, hardwareId: l.hardwareId, hourlyRate: l.hourlyRate }))
  }

  if (!db) {
    throw new Error('Firebase is not connected.')
  }

  const snap = await getDocs(query(collection(db, 'lockers'), orderBy('lockerNumber')))
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Locker))
}

function sortBookingsByNewest<T extends Record<string, any>>(items: T[]) {
  return [...items].sort((a, b) => {
    const aValue = a.createdAt && typeof a.createdAt.toDate === 'function'
      ? a.createdAt.toDate().getTime()
      : new Date(a.createdAt || 0).getTime()

    const bValue = b.createdAt && typeof b.createdAt.toDate === 'function'
      ? b.createdAt.toDate().getTime()
      : new Date(b.createdAt || 0).getTime()

    return bValue - aValue
  })
}

async function loadUserBookings(userId: string): Promise<any[]> {
  if (!db) return []
  const q = query(collection(db, 'bookings'), where('userId', '==', userId))
  const snap = await getDocs(q)
  return sortBookingsByNewest(snap.docs.map(d => ({ id: d.id, ...d.data() })))
}

async function ensureDefaultLockers() {
  if (!db) return
  const snap = await getDocs(collection(db, 'lockers'))
  if (snap.size >= 8) return

  const tasks = Array.from({ length: 8 }, (_, index) => {
    const number = index + 1
    const id = `locker-${String(number).padStart(2, '0')}`
    return setDoc(doc(db, 'lockers', id), {
      id,
      lockerNumber: number,
      status: 'AVAILABLE',
      isOpen: false,
      isOccupied: false,
      bookingId: '',
      userId: '',
      accessCode: '',
      rentalStart: '',
      rentalEnd: '',
      lastUpdated: Date.now(),
      hourlyRate: 2,
      hardwareId: `LOCKER-${String(number).padStart(2, '0')}`
    }, { merge: true })
  })

  await Promise.all(tasks)
}

function Rent() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [lockers, setLockers] = useState<Locker[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hours, setHours] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const hourOptions = [1, 2, 5, 12, 24, 48]

  useEffect(() => {
    let active = true
    let unsubscribeLocks: (() => void) | undefined
    let unsubscribeBookings: (() => void) | undefined

    async function fetchLockers() {
      try {
        setLoading(true)
        setError('')
        if (!db) {
          throw new Error('Firebase is not connected.')
        }

        await ensureDefaultLockers()

        // Subscribe to bookings to keep cache fresh (all PAID bookings)
        const bookingQuery = query(
          collection(db, 'bookings'),
          where('paymentStatus', '==', 'PAID')
        )
        unsubscribeBookings = onSnapshot(bookingQuery, (snap) => {
          if (!active) return
          const now = Date.now()
          cachedActiveBookings.clear()
          for (const docSnap of snap.docs) {
            const booking = docSnap.data() as any
            if (booking.rentalEnd && new Date(booking.rentalEnd).getTime() > now) {
              cachedActiveBookings.set(docSnap.id, { id: docSnap.id, ...booking })
            }
          }
          lastBookingCheckTime = now
        }, (e) => {
          console.error('[RENT] Bookings subscription error:', e?.message)
        })

        // Subscribe to lockers
        const qy = query(collection(db, 'lockers'), orderBy('lockerNumber'))
        unsubscribeLocks = onSnapshot(qy, (snap) => {
          if (!active) return
          const all = snap.docs.map(d => {
            const item = d.data() as any
            const effectiveStatus = getEffectiveLockerStatus(item)
            return {
              id: d.id,
              ...item,
              status: effectiveStatus as any
            } as Locker
          })

          void Promise.allSettled(
            all.filter((item) => hasExpiredRental(item) && !hasActiveRental(item))
              .map((item) => releaseExpiredLocker(item.id))
          )

          setLockers(all)
          setSelectedId((current) => current ?? all.find(l => isLockerBookable(l))?.id ?? all[0]?.id ?? null)
          setLoading(false)
        }, (e) => {
          if (active) {
            setError(e?.message || 'Something went wrong. Please try again.')
            setLoading(false)
          }
        })
      } catch (e: any) {
        if (active) setError(e?.message || 'Something went wrong. Please try again.')
        if (active) setLoading(false)
      }
    }

    void fetchLockers()
    return () => {
      active = false
      unsubscribeLocks?.()
      unsubscribeBookings?.()
    }
  }, [])

  const selected = lockers.find(l => l.id === selectedId) || null
  const total = selected ? Number((RM2_PER_HOUR * hours).toFixed(2)) : 0

  function startCheckout() {
    if (!user) {
      navigate('/login?next=/rent')
      return
    }

    if (!selected) {
      setError('Please choose a locker.')
      return
    }

    sessionStorage.setItem('smart-locker-demo-checkout', JSON.stringify({ lockerId: selected.id, lockerNumber: selected.lockerNumber, hours }))
    navigate('/checkout')
  }

  return (
    <section className="page">
      <div className="eyebrow">RENT A LOCKER</div>
      <h1 className="page-title">Choose a Locker</h1>
      <p className="muted">Pick an available locker to continue.</p>

      {loading && <div className="center"><Spinner /></div>}
      {!loading && !error && lockers.length === 0 && <div className="empty"><div>▣</div><h2>No lockers available</h2><p>There are no lockers ready for rental right now.</p></div>}
      {!loading && !error && lockers.length > 0 && (
        <div className="locker-grid">
          {lockers.map(l => {
            const status = normalizeLockerStatus(l.status)
            const isAvailable = isLockerBookable(l)
            const displayStatus = isAvailable ? 'AVAILABLE' : 'BOOKED'
            return (
              <button
                disabled={!isAvailable}
                className={'locker-card ' + (selectedId === l.id ? 'selected' : '')}
                key={l.id}
                onClick={() => setSelectedId(l.id)}
              >
                <div className="locker-head">
                  <span>Locker {String(l.lockerNumber).padStart(2, '0')}</span>
                  <i className={displayStatus.toLowerCase()}>{isAvailable ? 'Available' : 'Currently Unavailable'}</i>
                </div>
                <div className="big-locker">▦</div>
                <div className="price">RM {Number(l.hourlyRate).toFixed(2)} <small>/ hour</small></div>
                <span className="select-label">{isAvailable ? 'Choose Locker' : 'Currently Unavailable'}</span>
              </button>
            )
          })}
        </div>
      )}

      {selected && (
        <div className="checkout-panel">
          <div>
            <span>Locker {String(selected.lockerNumber).padStart(2, '0')}</span>
            <h2>How long would you like to rent the locker?</h2>
            <p className="muted">RM2 / hour</p>
            <select value={hours} onChange={e => setHours(Number(e.target.value))}>
              {hourOptions.map(value => <option key={value} value={value}>{value} {value === 1 ? 'hour' : 'hours'}</option>)}
            </select>
          </div>
          <div className="total">
            <small>Total</small>
            <strong>{formatCurrency(total)}</strong>
            <p className="muted">{hours} hours × RM2 = {formatCurrency(total)}</p>
            <button className="btn primary" onClick={startCheckout}>Pay Now →</button>
          </div>
        </div>
      )}

      {error && <div className="error">{error}</div>}
    </section>
  )
}

function Checkout() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [checkout, setCheckout] = useState<{ lockerId: string; lockerNumber: number; hours: number; bookingId?: string } | null>(null)
  const [processing, setProcessing] = useState(false)
  const [success, setSuccess] = useState(false)
  const [receipt, setReceipt] = useState<any | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const saved = sessionStorage.getItem('smart-locker-demo-checkout')
    if (!saved) {
      navigate('/rent')
      return
    }
    setCheckout(JSON.parse(saved))
  }, [navigate])

  useEffect(() => {
    if (!user) {
      navigate('/login?next=/checkout')
    }
  }, [navigate, user])

  useEffect(() => {
    if (!user || !checkout || checkout.bookingId) return

    void (async () => {
      try {
        const pending = await ensurePendingBooking({
          lockerId: checkout.lockerId,
          durationHours: checkout.hours,
          lockerNumber: checkout.lockerNumber,
          bookingId: checkout.bookingId
        })
        const next = { ...checkout, bookingId: pending.id }
        sessionStorage.setItem('smart-locker-demo-checkout', JSON.stringify(next))
        setCheckout(next)
      } catch (e: any) {
        setError(e?.message || 'Your booking could not be prepared.')
      }
    })()
  }, [checkout, user])

  const lockerRate = useMemo(() => {
    const l = getDemoLockers().find(item => item.id === checkout?.lockerId)
    return l ? l.hourlyRate : 2
  }, [checkout])

  const total = checkout ? Number((RM2_PER_HOUR * checkout.hours).toFixed(2)) : 0
  const startTime = checkout ? new Date() : new Date()
  const expiryTime = checkout ? new Date(startTime.getTime() + checkout.hours * 60 * 60 * 1000) : new Date()

  async function handlePayment() {
    if (!checkout || !user) return

    try {
      setProcessing(true)
      setError('')
      const result = await createCheckout({
        lockerId: checkout.lockerId,
        durationHours: checkout.hours,
        bookingId: checkout.bookingId
      })
      const data = result.data as { bookingId?: string; url?: string; message?: string }
      if (!data.bookingId) {
        throw new Error('Payment succeeded but no booking ID was returned.')
      }
      console.log('[PAYMENT] navigating to receipt')
      navigate(`/checkout-success?booking=${encodeURIComponent(data.bookingId)}`)
    } catch (e: any) {
      console.error('[PAYMENT ERROR]', {
        code: e?.code,
        message: e?.message,
        name: e?.name
      })
      setProcessing(false)
      setError(e?.message || 'Your payment could not be completed. Please try again in a moment.')
    }
  }

  if (!checkout) return <div className="center"><Spinner /></div>

  return (
    <section className="page">
      <div className="eyebrow">CHECKOUT</div>
      <h1 className="page-title">Review Your Booking</h1>
      <div className="checkout-panel">
        <div><small>Customer</small><strong>{user?.displayName || 'Customer'}</strong></div>
        <div><small>Locker</small><strong>#{String(checkout.lockerNumber).padStart(2, '0')}</strong></div>
        <div><small>Rental Duration</small><strong>{checkout.hours} {checkout.hours === 1 ? 'hour' : 'hours'}</strong></div>
        <div><small>Starts</small><strong>{startTime.toLocaleString('ms-MY', { hour12: false })}</strong></div>
        <div><small>Ends</small><strong>{expiryTime.toLocaleString('ms-MY', { hour12: false })}</strong></div>
        <div><small>Price</small><strong>{formatCurrency(total)}</strong></div>
        <div><small>Payment Status</small><strong>Not paid yet</strong></div>
      </div>

      {processing && (
        <div className="center">
          <Spinner />
          <p className="muted">Processing your payment...</p>
        </div>
      )}

      {!success && !processing && (
        <div className="center">
          <div className="demo-card">
            <div className="eyebrow">Demo Payment</div>
            <h2>Pay Now</h2>
            <p>This is a demo payment only. No real money will be charged.</p>
            <div className="total"><strong>{formatCurrency(total)}</strong></div>
            <button className="btn primary" onClick={handlePayment} disabled={!checkout.bookingId}>Pay Now</button>
          </div>
        </div>
      )}

      {success && receipt && (
        <div className="receipt">
          <div className="receipt-head"><div><span>Booking Confirmed</span><h2>{receipt.receiptNumber}</h2></div><b>Paid • Demo Payment</b></div>
          <div className="receipt-grid">
            <div><small>Customer</small><strong>{receipt.customerName}</strong></div>
            <div><small>Email</small><strong>{receipt.customerEmail}</strong></div>
            <div><small>Locker</small><strong>#{String(receipt.lockerNumber).padStart(2, '0')}</strong></div>
            <div><small>Rental Duration</small><strong>{receipt.durationHours} {receipt.durationHours === 1 ? 'hour' : 'hours'}</strong></div>
            <div><small>Price per Hour</small><strong>{formatCurrency(RM2_PER_HOUR)}</strong></div>
            <div><small>Total Hours</small><strong>{receipt.durationHours}</strong></div>
            <div><small>Total</small><strong>{formatCurrency(Number(receipt.amount))}</strong></div>
            <div><small>Rental Starts</small><strong>{formatDateTime(receipt.startTime)}</strong></div>
            <div><small>Rental Ends</small><strong>{formatDateTime(receipt.expiryTime)}</strong></div>
            <div><small>Payment Status</small><strong>{receipt.paymentStatus}</strong></div>
            <div><small>Payment Date</small><strong>{formatDateTime(new Date(receipt.receiptDate))}</strong></div>
            <div><small>Reference</small><strong>{receipt.paymentReference}</strong></div>
          </div>
          <h3>Your Access Code</h3>
          <div className="code-list"><div><span>Access Code</span><b>{receipt.accessCode || receipt.codes?.[0] || '—'}</b></div></div>
          <p className="muted">Use this code to access your locker during your rental period.</p>
          <div className="actions">
            <button className="btn primary" type="button" onClick={() => window.print()}>Print Receipt</button>
            <button className="btn ghost" type="button" onClick={() => downloadReceiptPdf(receipt)}>Download Receipt</button>
            <button className="btn ghost" type="button" onClick={() => {
              window.location.href = `mailto:${receipt.customerEmail}?subject=${encodeURIComponent('Smart Locker Receipt')}&body=${encodeURIComponent(`Payment confirmed\n\nCustomer: ${receipt.customerName}\nLocker: ${receipt.lockerNumber}\nRental Duration: ${receipt.durationHours} hours\nPrice per hour: RM2.00\nTotal amount: RM ${Number(receipt.amount).toFixed(2)}\nAccess Code: ${receipt.accessCode || receipt.codes?.[0] || ''}`)}`
            }}>Email Receipt</button>
          </div>
          <p className="muted">Demo mode does not send a real email.</p>
          <div className="actions"><Link className="btn primary" to="/my-locker">My Locker</Link><Link className="btn ghost" to="/">Home</Link></div>
        </div>
      )}

      {error && <div className="error">{error}</div>}
    </section>
  )
}

function Success() {
  const { user } = useAuth()
  const location = useLocation()
  const [receipt, setReceipt] = useState<any | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!user) {
      setError('Please log in to view your receipt.')
      return
    }

    const params = new URLSearchParams(location.search)
    const bookingId = params.get('booking')
    if (!bookingId) {
      setError('Your receipt is not ready yet.')
      return
    }

    void (async () => {
      try {
        const bookings = await loadUserBookings(user.uid)
        const requested = bookings.filter((item: any) => item.id === bookingId)
        if (requested.length === 0) {
          setError('Your receipt is not ready yet.')
          return
        }

        const receipt = await getReceipt({ bookingId: requested[0].id })
        setReceipt(receipt.data)
      } catch (e: any) {
        setError(e?.message || 'Your receipt is not ready yet.')
      }
    })()
  }, [location.search, user])

  return (
    <section className="page success">
      <div className="center"><div className="success-icon">✓</div><div className="eyebrow">Payment Successful</div><h1>Your locker is booked.</h1><p>This is a demo payment only.</p></div>
      {receipt ? (
        <div className="receipt">
          <div className="receipt-head"><div><span>Receipt</span><h2>{receipt.receiptNumber}</h2></div><b>Paid • Demo Payment</b></div>
          <div className="receipt-grid">
            <div><small>Customer Name</small><strong>{receipt.customerName}</strong></div>
            <div><small>Customer Email</small><strong>{receipt.customerEmail}</strong></div>
            <div><small>Locker Number</small><strong>#{String(receipt.lockerNumber).padStart(2, '0')}</strong></div>
            <div><small>Rental Duration</small><strong>{receipt.durationHours} {receipt.durationHours === 1 ? 'hour' : 'hours'}</strong></div>
            <div><small>Price Per Hour</small><strong>{formatCurrency(Number(receipt.pricePerHour || RM2_PER_HOUR))}</strong></div>
            <div><small>Total Price</small><strong>{formatCurrency(Number(receipt.amount))}</strong></div>
            <div><small>Payment Date</small><strong>{formatDateTime(new Date(receipt.paymentDate || receipt.receiptDate))}</strong></div>
            <div><small>Rental Start</small><strong>{formatDateTime(receipt.startTime)}</strong></div>
            <div><small>Rental End</small><strong>{formatDateTime(receipt.expiryTime)}</strong></div>
            <div><small>Access Code</small><strong>{receipt.accessCode || receipt.codes?.[0] || '—'}</strong></div>
            <div><small>Payment Status</small><strong>{receipt.paymentStatus} / {receipt.paymentReference || 'DEMO PAYMENT'}</strong></div>
          </div>
          <h3>Your Access Code</h3><div className="code-list"><div><span>Access Code</span><b>{receipt.accessCode || receipt.codes?.[0] || '—'}</b></div></div>
        </div>
      ) : (
        <div className="center"><Spinner /><p className="muted">Preparing your receipt...</p></div>
      )}
      {error && <div className="error">{error}</div>}
      <div className="actions"><Link className="btn primary" to="/my-locker">My Locker</Link><Link className="btn ghost" to="/">Home</Link></div>
    </section>
  )
}

function MyLocker() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [bookings, setBookings] = useState<any[]>([])
  const [activeRentals, setActiveRentals] = useState<any[]>([])
  const [lockerMap, setLockerMap] = useState<Record<string, any>>({})
  const [codeInputs, setCodeInputs] = useState<Record<string, string>>({})
  const [message, setMessage] = useState('')
  const [now, setNow] = useState(Date.now())

  const getBookingCardStatus = (booking: any, locker: any) => {
    const lockerStatus = normalizeLockerStatus(locker?.status)
    const paymentStatus = String(booking?.paymentStatus || '').toUpperCase()
    const endTime = booking?.rentalEnd ? new Date(booking.rentalEnd).getTime() : 0
    const isExpired = endTime > 0 && endTime <= Date.now()

    if (lockerStatus === 'OPEN') return 'OPEN'
    if (paymentStatus === 'EXPIRED' || isExpired) return 'EXPIRED'
    if (paymentStatus === 'PAID' && endTime > Date.now()) return 'ACTIVE'
    if (paymentStatus === 'PAID' && endTime <= Date.now()) return 'COMPLETED'
    return lockerStatus === 'BOOKED' ? 'BOOKED' : paymentStatus || 'BOOKED'
  }

  const canOpenBooking = (booking: any, locker: any) => {
    if (!booking || !locker || !user) return false
    if (booking.userId !== user.uid) return false
    if (String(locker.bookingId || '') !== String(booking.id)) return false
    if (String(locker.userId || '') !== String(user.uid)) return false
    if (String(booking.accessCode || '').trim() === '') return false
    const paymentStatus = String(booking.paymentStatus || '').toUpperCase()
    const endTime = booking?.rentalEnd ? new Date(booking.rentalEnd).getTime() : 0
    return paymentStatus === 'PAID' && endTime > Date.now() && !locker.isOpen
  }

  useEffect(() => {
    if (!user || !db) return

    const q = query(collection(db, 'bookings'), where('userId', '==', user.uid))
    const bookingsUnsubscribe = onSnapshot(q, (snap) => {
      const next = sortBookingsByNewest(snap.docs.map(d => ({ id: d.id, ...d.data() })))
      setBookings(next)

      const nextActive = next.filter((item: any) => isActivePaidBookingForUser(item, user.uid))
      setActiveRentals(nextActive)
    }, (error) => {
      setMessage(error?.message || 'Unable to load bookings right now.')
    })

    const lockerQuery = query(collection(db, 'lockers'))
    const lockersUnsubscribe = onSnapshot(lockerQuery, (snap) => {
      const nextMap: Record<string, any> = {}
      snap.docs.forEach((d) => {
        nextMap[d.id] = { id: d.id, ...d.data() }
      })

      void Promise.allSettled(
        Object.values(nextMap)
          .filter((item: any) => normalizeLockerStatus(item?.status) === 'BOOKED' && item?.rentalEnd && new Date(item.rentalEnd).getTime() <= Date.now())
          .map((item: any) => releaseExpiredLocker(item.id))
      )

      setLockerMap(nextMap)
    }, (error) => {
      setMessage(error?.message || 'Unable to load locker status right now.')
    })

    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      bookingsUnsubscribe()
      lockersUnsubscribe()
      clearInterval(timer)
    }
  }, [user])

  useEffect(() => {
    if (!user || !bookings.length) return

    const timers: number[] = []
    bookings.forEach((booking: any) => {
      const locker = lockerMap[booking.lockerId]
      if (!locker || !locker.isOpen || !canOpenBooking(booking, locker)) return

      const timeout = window.setTimeout(async () => {
        try {
          const result = await closeLockerForBooking({ bookingId: booking.id, lockerId: booking.lockerId })
          setMessage(result.data.message)
        } catch (e: any) {
          setMessage(e?.message || 'The locker could not be closed.')
        }
      }, 15000)

      timers.push(timeout)
    })

    return () => {
      timers.forEach((id) => window.clearTimeout(id))
    }
  }, [bookings, lockerMap, user])

  async function openLocker(booking: any) {
    if (!user || !booking) return
    const enteredCode = (codeInputs[booking.id] ?? booking.accessCode ?? '').toString()
    try {
      const result = await verifyAccessCode({ rentalId: booking.id, lockerId: booking.lockerId, code: enteredCode })
      setMessage(result.data.message)
      setCodeInputs((current) => ({ ...current, [booking.id]: '' }))
    } catch (e: any) {
      setMessage(e?.message || 'The access code is not correct.')
    }
  }

  async function handleBookingLockerAction(booking: any, locker: any) {
    if (!user || !booking || !locker) {
      setMessage('Please log in to continue.')
      return
    }

    if (booking.userId !== user.uid) {
      setMessage('This locker is not linked to your account.')
      return
    }

    if (String(locker.bookingId || '') !== String(booking.id) || String(locker.userId || '') !== String(user.uid)) {
      setMessage('This locker is not linked to your active booking.')
      return
    }

    const bookingEnd = new Date(booking.rentalEnd).getTime()
    if (bookingEnd <= Date.now()) {
      setMessage('Your rental has ended. Please book again.')
      return
    }

    if (String(booking.paymentStatus || '').toUpperCase() !== 'PAID') {
      setMessage('This booking is not active right now.')
      return
    }

    try {
      if (locker.isOpen) {
        const result = await closeLockerForBooking({ bookingId: booking.id, lockerId: booking.lockerId })
        setMessage(result.data.message)
      } else {
        const result = await verifyAccessCode({ rentalId: booking.id, lockerId: booking.lockerId, code: String(booking.accessCode || '') })
        setMessage(result.data.message)
      }
    } catch (e: any) {
      setMessage(e?.message || 'The locker could not be opened.')
    }
  }

  if (!user) return <div className="center"><h2>Please log in to continue.</h2><Link className="btn primary" to="/login">Log In</Link></div>

  return (
    <section className="page">
      <div className="eyebrow">MY LOCKER</div>
      <h1 className="page-title">My Locker</h1>

      <div className="booking-section">
        {activeRentals.length > 0 ? (
          <div className="booking-list">
            {activeRentals.map((activeRental: any) => {
              const locker = lockerMap[activeRental.lockerId]
              const remaining = Math.max(0, new Date(activeRental.rentalEnd).getTime() - now)
              const codeValue = codeInputs[activeRental.id] ?? activeRental.accessCode ?? ''
              const isOpen = Boolean(locker?.isOpen)
              const canOpen = !isOpen && activeRental.paymentStatus === 'PAID' && new Date(activeRental.rentalEnd).getTime() > Date.now()

              return (
                <div className="mylocker" key={activeRental.id}>
                  <div className="active-badge">● Currently Rented</div>
                  <h2>Locker {String(activeRental.lockerNumber || locker?.lockerNumber || 0).padStart(2, '0')}</h2>
                  <div className="countdown"><small>Time Remaining</small><strong>{new Date(remaining).toISOString().slice(11, 19)}</strong></div>
                  <div className="details">
                    <div><small>Rental Started</small><b>{new Date(activeRental.rentalStart).toLocaleString()}</b></div>
                    <div><small>Rental Ends</small><b>{new Date(activeRental.rentalEnd).toLocaleString()}</b></div>
                    <div><small>Status</small><b>{activeRental.paymentStatus === 'PAID' ? 'Active' : 'Booked'}</b></div>
                  </div>
                  <h3>Your Access Code</h3>
                  <div className="code-list"><div><span>Access Code</span><b>{activeRental.accessCode || '—'}</b></div></div>
                  <label className="code-label">Enter your access code<input inputMode="numeric" maxLength={6} value={codeValue} onChange={e => setCodeInputs((current) => ({ ...current, [activeRental.id]: e.target.value.replace(/\D/g, '') }))} placeholder="••••••" /></label>
                  {canOpen && <button className="btn primary wide" type="button" onClick={() => openLocker(activeRental)} disabled={remaining <= 0 || codeValue.length !== 6}>Open Locker</button>}
                  {!canOpen && locker && isOpen && <button className="btn ghost wide" type="button" onClick={() => handleBookingLockerAction(activeRental, locker)}>Close Locker</button>}
                  {message && <div className={message.includes('berjaya') ? 'granted' : 'error'}>{message}</div>}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="empty"><div>▣</div><h2>No active rental</h2><p>You don't have an active locker booked yet.</p><Link className="btn primary" to="/rent">Rent a Locker</Link></div>
        )}
      </div>

      <div className="booking-section">
        <div className="eyebrow">BOOKING LIST</div>
        <h2 className="page-title small">My Bookings</h2>
        {bookings.length === 0 ? (
          <div className="empty"><div>▣</div><h3>No bookings yet</h3><p>Your booking history will appear here after checkout.</p></div>
        ) : (
          <div className="booking-list">
            {bookings.map((booking: any) => {
              const locker = lockerMap[booking.lockerId]
              const status = getBookingCardStatus(booking, locker)
              const canOpen = canOpenBooking(booking, locker)
              const isOpen = Boolean(locker?.isOpen)

              return (
                <article className="booking-card" key={booking.id}>
                  <div className="booking-head">
                    <div>
                      <span>Locker {String(booking.lockerNumber || locker?.lockerNumber || 0).padStart(2, '0')}</span>
                      <h3>Booking ID: {booking.id.slice(0, 12)}</h3>
                    </div>
                    <strong>{status}</strong>
                  </div>
                  <div className="booking-meta">
                    <div><small>Duration</small><b>{Number(booking.rentalHours || 0)} {Number(booking.rentalHours || 0) === 1 ? 'Hour' : 'Hours'}</b></div>
                    <div><small>Rental</small><b>{formatDateTime(booking.rentalStart)} - {formatDateTime(booking.rentalEnd)}</b></div>
                    <div><small>Total</small><b>{formatCurrency(Number(booking.totalPrice || 0))}</b></div>
                    <div><small>Payment</small><b>{String(booking.paymentStatus || 'PAID').toUpperCase()}</b></div>
                    <div><small>Access Code</small><b>{booking.accessCode || '—'}</b></div>
                    <div><small>Booked</small><b>{formatDateTime(booking.createdAt?.toDate ? booking.createdAt.toDate() : booking.createdAt || new Date())}</b></div>
                    <div><small>Locker Status</small><b>{locker ? normalizeLockerStatus(locker.status) : '—'}</b></div>
                  </div>
                  <div className="actions compact">
                    {canOpen && <button className="btn primary" type="button" onClick={() => handleBookingLockerAction(booking, locker)}>Open Locker</button>}
                    {locker && isOpen && !canOpen && <button className="btn ghost" type="button" onClick={() => handleBookingLockerAction(booking, locker)}>Close Locker</button>}
                    <button className="btn ghost" type="button" onClick={() => navigate(`/checkout-success?booking=${encodeURIComponent(booking.id)}`)}>View Receipt</button>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}

function LocationPage() {
  return <section className="page">
    <div className="eyebrow">LOCATION</div>
    <h1 className="page-title">JMTI Penang</h1>
    <div className="location-grid">
      <div className="map-placeholder">
        <iframe
          title="JMTI Penang Map"
          src="https://www.google.com/maps?q=JMTI%20Penang&output=embed"
          style={{ border: 0, width: '100%', height: '320px', borderRadius: '16px' }}
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
        />
      </div>
      <div className="location-info">
        <h2>JMTI Penang</h2>
        <p>JMTI Penang, Pulau Pinang, Malaysia</p>
        <p>Open 24/7</p>
        <a className="btn ghost" href="https://maps.google.com/?q=JMTI+Penang+Pulau+Pinang+Malaysia" target="_blank" rel="noreferrer">Get Directions →</a>
        <div className="qr"><QRCodeCanvas value={APP_URL} size={180} /><b>Scan to Rent</b><small>{APP_URL}</small></div>
      </div>
    </div>
  </section>
}

function Reviews() {
  const { user } = useAuth()
  const [items, setItems] = useState<any[]>([])
  const [rating, setRating] = useState(5)
  const [review, setReview] = useState('')
  const [sent, setSent] = useState(false)

  useEffect(() => {
    const reviews = getDemoReviews()
    setItems(reviews)
  }, [sent])

  async function send() {
    if (!user) return
    await submitReview({ rating, review })
    setReview('')
    setSent(true)
  }

  return <section className="page"><div className="eyebrow">CUSTOMER REVIEWS</div><h1 className="page-title">What our customers say</h1>
    <div className="reviews">{items.map((x, i) => <article key={i}><div className="stars">{'★'.repeat(x.rating)}{'☆'.repeat(5 - x.rating)}</div><p>“{x.review}”</p><b>{x.name || 'Customer'}</b><small>{x.createdAt || ''}</small></article>)}</div>
    {user && <div className="review-form"><h2>Leave a review</h2><div className="rating-buttons">{[1, 2, 3, 4, 5].map(n => <button key={n} className={n <= rating ? 'on' : ''} onClick={() => setRating(n)}>★</button>)}</div><textarea value={review} onChange={e => setReview(e.target.value)} placeholder="Tell us about your experience..." /><button className="btn primary" disabled={!review.trim()} onClick={send}>Send Review</button>{sent && <small>Your review has been sent for approval.</small>}</div>}
  </section>
}

function Contact() {
  const [form, setForm] = useState({ name: '', email: '', phone: '', message: '' })
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  async function send(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name || !form.email || !form.message) {
      setError('Nama, emel dan mesej diperlukan.')
      return
    }

    try {
      await submitContact(form)
      setSent(true)
      setError('')
      setForm({ name: '', email: '', phone: '', message: '' })
    } catch (e: any) {
      setError(e?.message || 'Tidak dapat menghantar mesej.')
    }
  }

  return <section className="page"><div className="eyebrow">CONTACT US</div><h1 className="page-title">Need help?</h1><div className="contact-grid"><form onSubmit={send} className="form-card">{(['name', 'email', 'phone'] as const).map(k => <input required key={k} type={k === 'email' ? 'email' : 'text'} placeholder={k === 'email' ? 'Email Address' : k === 'phone' ? 'Phone Number' : 'Full Name'} value={form[k]} onChange={e => setForm({ ...form, [k]: e.target.value })} />)}
    <textarea required placeholder="Message" value={form.message} onChange={e => setForm({ ...form, message: e.target.value })} /><button className="btn primary">Send Message</button>{sent && <span className="granted">Your message has been sent.</span>}{error && <div className="error">{error}</div>}</form>
    <div className="contact-info"><h2>Smart Digital Locker</h2><p>hello@yourdomain.com</p><p>+60 12-345 6789</p><p>Open 24 hours, 7 days</p></div></div></section>
}

function Login() {
  const { user, login, signUp, resetPassword } = useAuth()
  const navigate = useNavigate()
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [form, setForm] = useState({ name: '', phone: '', email: '', password: '', confirmPassword: '' })
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  if (user) return <div className="center"><h2>You are already logged in.</h2><Link className="btn primary" to="/my-locker">My Locker</Link></div>

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    try {
      setError('')
      setSuccess('')
      if (mode === 'signup') {
        await signUp(form.name, form.email, form.password, form.confirmPassword, form.phone)
      } else {
        await login(form.email, form.password)
      }
      navigate('/my-locker')
    } catch (e: any) {
      setError(e?.message || 'We couldn’t continue. Please try again.')
    }
  }

  async function handleForgotPassword() {
    if (!form.email.trim()) {
      setError('Please enter your email address to reset your password.')
      return
    }

    try {
      setError('')
      setSuccess('')
      await resetPassword(form.email)
      setSuccess('Reset link sent! Please check your email to reset your password.')
    } catch (e: any) {
      setError(e?.message || 'We couldn’t send the reset link. Please try again.')
    }
  }

  return <section className="auth"><div className="auth-card"><div className="eyebrow">{mode === 'login' ? 'Welcome Back' : 'Create Your Account'}</div><h1>{mode === 'login' ? 'Log in to manage your locker.' : 'Sign up to rent and manage your locker.'}</h1><form onSubmit={submit}>{mode === 'signup' && <><input required placeholder="Full Name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /><input placeholder="Phone Number" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></>}<input required type="email" placeholder="Email Address" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /><input required minLength={6} type="password" placeholder="Password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />{mode === 'signup' && <input required minLength={6} type="password" placeholder="Confirm Password" value={form.confirmPassword} onChange={e => setForm({ ...form, confirmPassword: e.target.value })} />}<button className="btn primary wide">{mode === 'login' ? 'Log In' : 'Create Account'}</button></form>{error && <div className="error">{error}</div>}{success && <div className="granted">{success}</div>}{mode === 'login' && <button type="button" className="switch" onClick={handleForgotPassword}>Forgot Password?</button>}<button className="switch" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); setSuccess('') }}>{mode === 'login' ? 'Need an account? Sign up' : 'Already have an account? Log in'}</button></div></section>
}

function Admin() {
  const { user } = useAuth()
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const [lockers, setLockers] = useState<Locker[]>([])
  const [rentals, setRentals] = useState<any[]>([])
  const [reviews, setReviews] = useState<any[]>([])

  useEffect(() => {
    if (!user) return
    void getProfile(user.uid).then(p => setAllowed(p?.role === 'admin'))
    void (async () => {
      try {
        const all = await loadLockers()
        setLockers(all)
      } catch {
        setLockers([])
      }
    })()
  }, [user])

  if (allowed === null) return <div className="center"><Spinner /></div>
  if (!allowed) return <div className="center"><h2>Admin only</h2></div>

  return <section className="page"><div className="eyebrow">ADMIN DASHBOARD</div><h1 className="page-title">Operations.</h1><div className="admin-grid"><div className="admin-card"><h2>Lockers</h2>{lockers.map(l => <div className="admin-row" key={l.id}><span>Locker {String(l.lockerNumber).padStart(2, '0')}</span><b className={l.status}>{l.status.toUpperCase()}</b></div>)}</div><div className="admin-card"><h2>Recent rentals</h2>{rentals.slice(0, 8).map(r => <div className="admin-row" key={r.id}><span>Locker {String(r.lockerNumber).padStart(2, '0')}</span><span>{r.paymentStatus}</span><span>RM {Number(r.amount).toFixed(2)}</span></div>)}</div><div className="admin-card"><h2>Reviews</h2>{reviews.slice(0, 8).map(r => <div className="admin-row" key={r.id}><span>{'★'.repeat(r.rating)}</span><span>{r.status}</span></div>)}</div></div></section>
}

function App() { return <AuthProvider><Layout /></AuthProvider> }

export default App
