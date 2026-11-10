export type DemoLockerStatus = 'available' | 'booked' | 'open' | 'closed' | 'occupied' | 'maintenance' | 'expired' | 'offline'

export interface DemoLocker {
  id: string
  lockerNumber: number
  name: string
  status: DemoLockerStatus
  hourlyRate: number
  hardwareId: string
  isOpen: boolean
  isOccupied: boolean
  bookingId: string
  userId: string
  accessCode: string
  rentalStart: number | null
  rentalEnd: number | null
  lastUpdated: number
}

export interface DemoRental {
  id: string
  userId: string
  lockerId: string
  lockerNumber: number
  startTime: { seconds: number }
  expiryTime: { seconds: number }
  status: 'active' | 'expired' | 'cancelled'
  paymentStatus: 'paid' | 'expired' | 'failed'
  amount: number
  durationHours: number
  customerName: string
  customerEmail: string
  paymentReference: string
  receiptNumber: string
  accessCode: string
  accessCodes?: string[]
  receiptDate: string
  createdAt: number
  lockerStatus: DemoLockerStatus
}

const LOCKER_KEYS = 'smart-locker-demo-lockers'
const RENTAL_KEYS = 'smart-locker-demo-rentals'
const REVIEW_KEYS = 'smart-locker-demo-reviews'
const CONTACT_KEYS = 'smart-locker-demo-contacts'

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : fallback
  } catch {
    return fallback
  }
}

function writeStorage<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore localStorage write failures in demo mode
  }
}

function pad2(value: number) {
  return String(value).padStart(2, '0')
}

export function ensureDemoLockers(): DemoLocker[] {
  const current = readStorage<DemoLocker[]>(LOCKER_KEYS, [])

  if (current.length === 8) {
    return current
  }

  const next: DemoLocker[] = Array.from({ length: 8 }, (_, index) => {
    const lockerNumber = index + 1
    return {
      id: `locker-${pad2(lockerNumber)}`,
      lockerNumber,
      name: `Locker ${lockerNumber}`,
      status: 'available',
      hourlyRate: 2,
      hardwareId: `HARDWARE-${pad2(lockerNumber)}`,
      isOpen: false,
      isOccupied: false,
      bookingId: '',
      userId: '',
      accessCode: '',
      rentalStart: null,
      rentalEnd: null,
      lastUpdated: Date.now()
    }
  })

  writeStorage(LOCKER_KEYS, next)
  return next
}

export function getDemoLockers(): DemoLocker[] {
  return ensureDemoLockers()
}

export function getDemoLockerById(lockerId: string): DemoLocker | undefined {
  return ensureDemoLockers().find(locker => locker.id === lockerId)
}

export function getDemoRentals(): DemoRental[] {
  return readStorage<DemoRental[]>(RENTAL_KEYS, [])
}

export function getDemoReviews() {
  return readStorage<any[]>(REVIEW_KEYS, [])
}

export function getDemoContacts() {
  return readStorage<any[]>(CONTACT_KEYS, [])
}

export function syncExpiredDemoRentals() {
  const rentals = getDemoRentals()
  let changed = false

  const next = rentals.map(rental => {
    if (rental.status === 'active' && rental.expiryTime.seconds * 1000 <= Date.now()) {
      changed = true
      updateDemoLockerStatus(rental.lockerId, 'available')
      return { ...rental, status: 'expired', paymentStatus: 'expired' }
    }
    return rental
  })

  if (changed) {
    writeStorage(RENTAL_KEYS, next)
  }

  return next
}

function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000))
}

function generateUniqueCode(): string {
  let code = generateCode()
  const rentals = getDemoRentals()
  while (rentals.some(rental => rental.accessCode === code)) {
    code = generateCode()
  }
  return code
}

function makeReceiptNumber() {
  return `DR-${Date.now().toString().slice(-8)}`
}

function updateDemoLockerStatus(lockerId: string, status: DemoLockerStatus, patch: Partial<DemoLocker> = {}) {
  const lockers = ensureDemoLockers()
  const next = lockers.map(locker => locker.id === lockerId ? { ...locker, ...patch, status, lastUpdated: Date.now() } : locker)
  writeStorage(LOCKER_KEYS, next)
}

export function createDemoPayment(input: {
  userId: string
  userName: string
  userEmail: string
  lockerId: string
  durationHours: number
}) {
  const lockers = ensureDemoLockers()
  const locker = lockers.find(item => item.id === input.lockerId)

  if (!locker) {
    throw new Error('Locker tidak ditemui.')
  }

  if (locker.status !== 'available') {
    throw new Error('Locker sedang digunakan atau dalam penyelenggaraan.')
  }

  const start = new Date()
  const expiry = new Date(start.getTime() + input.durationHours * 60 * 60 * 1000)
  const accessCode = generateUniqueCode()
  const paymentReference = `DEMO-${Math.random().toString(36).slice(2, 10).toUpperCase()}`
  const rental: DemoRental = {
    id: `rental-${Date.now()}`,
    userId: input.userId,
    lockerId: locker.id,
    lockerNumber: locker.lockerNumber,
    startTime: { seconds: Math.floor(start.getTime() / 1000) },
    expiryTime: { seconds: Math.floor(expiry.getTime() / 1000) },
    status: 'active',
    paymentStatus: 'paid',
    amount: Number((2 * input.durationHours).toFixed(2)),
    durationHours: input.durationHours,
    customerName: input.userName,
    customerEmail: input.userEmail,
    paymentReference,
    receiptNumber: makeReceiptNumber(),
    accessCode,
    accessCodes: [accessCode],
    receiptDate: new Date().toISOString(),
    createdAt: Date.now(),
    lockerStatus: 'booked'
  }

  const existing = getDemoRentals()
  writeStorage(RENTAL_KEYS, [rental, ...existing])
  updateDemoLockerStatus(locker.id, 'booked', {
    isOpen: false,
    isOccupied: true,
    bookingId: rental.id,
    userId: input.userId,
    accessCode,
    rentalStart: start.getTime(),
    rentalEnd: expiry.getTime(),
    lastUpdated: Date.now()
  })

  return rental
}

export function getDemoReceiptForUser(userId: string, rentalId?: string) {
  const rentals = getDemoRentals().filter(rental => rental.userId === userId)
  const rental = rentalId ? rentals.find(item => item.id === rentalId) : rentals.find(item => item.status === 'active' || item.paymentStatus === 'paid')

  if (!rental) {
    return null
  }

  return {
    id: rental.id,
    receiptNumber: rental.receiptNumber,
    customerName: rental.customerName,
    customerEmail: rental.customerEmail,
    lockerNumber: rental.lockerNumber,
    durationHours: rental.durationHours,
    startTime: rental.startTime,
    expiryTime: rental.expiryTime,
    amount: rental.amount,
    paymentStatus: rental.paymentStatus,
    paymentReference: rental.paymentReference,
    accessCode: rental.accessCode,
    codes: rental.accessCodes || [rental.accessCode],
    receiptDate: rental.receiptDate,
    status: rental.status,
    lockerId: rental.lockerId,
    userId: rental.userId,
    pricePerHour: 2,
    totalHours: rental.durationHours,
    paymentDate: rental.receiptDate,
    rentalStart: rental.startTime,
    rentalExpiry: rental.expiryTime
  }
}

export function verifyDemoAccessCode(input: {
  userId: string
  rentalId: string
  lockerId: string
  code: string
}) {
  const rentals = getDemoRentals()
  const rental = rentals.find(item => item.id === input.rentalId)

  if (!rental) {
    return { granted: false, message: 'Sewa tidak dijumpai.' }
  }

  if (rental.userId !== input.userId || rental.lockerId !== input.lockerId) {
    return { granted: false, message: 'Kod akses tidak sah untuk pelanggan ini.' }
  }

  const expiryTime = rental.expiryTime.seconds * 1000
  if (Date.now() > expiryTime) {
    const updated = rentals.map(item => item.id === rental.id ? { ...item, status: 'expired', paymentStatus: 'expired', lockerStatus: 'expired' } : item)
    writeStorage(RENTAL_KEYS, updated)
    updateDemoLockerStatus(rental.lockerId, 'available', {
      isOpen: false,
      isOccupied: false,
      bookingId: '',
      userId: '',
      accessCode: '',
      rentalStart: null,
      rentalEnd: null
    })
    return { granted: false, message: 'Sewa telah tamat tempoh.' }
  }

  const enteredCode = input.code.trim()
  if (rental.accessCode !== enteredCode) {
    return { granted: false, message: 'Kod akses tidak sah.' }
  }

  updateDemoLockerStatus(rental.lockerId, 'open', {
    isOpen: true,
    isOccupied: true,
    bookingId: rental.id,
    userId: rental.userId,
    accessCode: rental.accessCode,
    rentalStart: rental.startTime.seconds * 1000,
    rentalEnd: rental.expiryTime.seconds * 1000,
    lastUpdated: Date.now()
  })

  return { granted: true, message: 'Locker berjaya dibuka.' }
}

export function submitDemoReview(input: { userId: string; name: string; rating: number; review: string }) {
  const list = getDemoReviews()
  const reviewItem = {
    id: `review-${Date.now()}`,
    userId: input.userId,
    name: input.name,
    rating: input.rating,
    review: input.review,
    status: 'approved',
    createdAt: new Date().toISOString()
  }
  writeStorage(REVIEW_KEYS, [reviewItem, ...list])
  return reviewItem
}

export function submitDemoContact(input: { name: string; email: string; phone: string; message: string }) {
  const list = getDemoContacts()
  const entry = {
    id: `contact-${Date.now()}`,
    ...input,
    status: 'new',
    createdAt: new Date().toISOString()
  }
  writeStorage(CONTACT_KEYS, [entry, ...list])
  return entry
}

export function getActiveDemoRentalForUser(userId: string) {
  const rentals = syncExpiredDemoRentals().filter(rental => rental.userId === userId)
  return rentals.find(rental => rental.status === 'active' && rental.paymentStatus === 'paid') || null
}

export function getDemoAccessCodesForUser(userId: string) {
  const rental = getActiveDemoRentalForUser(userId)
  return rental?.accessCodes || []
}

export function isDemoModeEnabled() {
  return false
}
