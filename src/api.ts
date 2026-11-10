import { getAuth } from 'firebase/auth'
import { collection, doc, getDoc, getDocs, query, serverTimestamp, setDoc, Timestamp, updateDoc, where, runTransaction } from 'firebase/firestore'
import { db } from './firebase'

function generateAccessCode() {
  const random = Math.floor(100000 + Math.random() * 900000)
  return String(random)
}

/** Reconcile existing active bookings with locker documents */
export const reconcileLockerBookings = async () => {
  if (!db) return { updated: 0, errors: 0 }

  const auth = getAuth()
  const user = auth.currentUser
  if (!user) {
    return { updated: 0, errors: 0 }
  }

  const profileSnap = await getDoc(doc(db, 'users', user.uid))
  if (!profileSnap.exists() || String(profileSnap.data()?.role || '').toLowerCase() !== 'admin') {
    return { updated: 0, errors: 0 }
  }

  try {
    // Find all PAID bookings with rentalEnd in the future
    const bookings = await getDocs(
      query(
        collection(db, 'bookings'),
        where('paymentStatus', '==', 'PAID')
      )
    )

    let updated = 0
    let errors = 0

    for (const bookingDoc of bookings.docs) {
      const booking = bookingDoc.data() as any

      // Check if booking is still active
      if (!booking.rentalEnd || new Date(booking.rentalEnd).getTime() <= Date.now()) {
        continue // Skip expired bookings
      }

      if (!booking.lockerId || !booking.userId) {
        continue // Skip invalid bookings
      }

      try {
        // Update the locker to link it to this booking
        const lockerRef = doc(db, 'lockers', booking.lockerId)
        const lockerSnap = await getDoc(lockerRef)

        if (!lockerSnap.exists()) {
          errors++
          console.warn(`[RECONCILE] Locker ${booking.lockerId} for booking ${bookingDoc.id} does not exist`)
          continue
        }

        const locker = lockerSnap.data() as any

        const bookingStart = booking.rentalStart || ''
        const bookingEnd = booking.rentalEnd || ''
        const bookingAccess = booking.accessCode || ''
        const needsSync =
          locker.status !== 'BOOKED' ||
          locker.isOpen !== false ||
          locker.isOccupied !== true ||
          locker.bookingId !== bookingDoc.id ||
          locker.userId !== booking.userId ||
          locker.accessCode !== bookingAccess ||
          locker.rentalStart !== bookingStart ||
          locker.rentalEnd !== bookingEnd

        if (needsSync) {
          await updateDoc(lockerRef, {
            status: 'BOOKED',
            isOpen: false,
            isOccupied: true,
            bookingId: bookingDoc.id,
            userId: booking.userId,
            accessCode: bookingAccess,
            rentalStart: bookingStart,
            rentalEnd: bookingEnd,
            lastUpdated: serverTimestamp()
          })
          updated++
          console.log(`[RECONCILE] Updated locker ${booking.lockerId} for booking ${bookingDoc.id}`)
        }
      } catch (e: any) {
        errors++
        console.error(`[RECONCILE] Error updating locker ${booking.lockerId}:`, e?.message)
      }
    }

    console.log(`[RECONCILE] Complete: ${updated} lockers updated, ${errors} errors`)
    return { updated, errors }
  } catch (e: any) {
    console.error('[RECONCILE] Fatal error:', e?.message)
    return { updated: 0, errors: 1 }
  }
}

async function generateUniqueAccessCode() {
  const code = generateAccessCode()
  return code
}

function normalizeLockerStatus(value?: string) {
  const next = (value || 'AVAILABLE').toString().trim().toUpperCase()
  switch (next) {
    case 'AVAILABLE':
    case 'BOOKED':
    case 'OPEN':
    case 'CLOSED':
    case 'EXPIRED':
    case 'OFFLINE':
      return next
    default:
      return 'AVAILABLE'
  }
}

function toDate(value: any) {
  if (!value) return new Date()
  if (typeof value.toDate === 'function') return value.toDate()
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? new Date() : date
}

export const releaseExpiredLocker = async (lockerId: string) => {
  if (!db) return false

  const lockerRef = doc(db, 'lockers', lockerId)
  const lockerSnap = await getDoc(lockerRef)
  if (!lockerSnap.exists()) return false

  const locker = lockerSnap.data() as any
  const status = String(locker.status || '').toUpperCase()
  const rentalEnd = locker.rentalEnd ? new Date(locker.rentalEnd).getTime() : null

  if (status !== 'BOOKED' && status !== 'OPEN' && status !== 'CLOSED') return false
  if (rentalEnd === null || rentalEnd > Date.now()) return false

  await updateDoc(lockerRef, {
    status: 'AVAILABLE',
    isOpen: false,
    isOccupied: false,
    bookingId: null,
    userId: null,
    accessCode: null,
    rentalStart: null,
    rentalEnd: null,
    lastUpdated: serverTimestamp()
  })

  return true
}

function logPaymentError(error: any) {
  console.error('[PAYMENT ERROR]', {
    code: error?.code,
    message: error?.message,
    name: error?.name
  })
}

async function loadUserBookingsForPayment(userId: string) {
  const bookingQuery = query(collection(db!, 'bookings'), where('userId', '==', userId))
  const existingBookingsSnap = await getDocs(bookingQuery)
  return existingBookingsSnap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() as any }))
}

function isPaidStatus(value: unknown) {
  return String(value || '').toUpperCase() === 'PAID'
}

function paidCheckoutResult(bookingId: string, message: string) {
  return {
    data: {
      bookingId,
      url: `/checkout-success?booking=${encodeURIComponent(bookingId)}`,
      message
    }
  }
}

export const ensurePendingBooking = async (payload: { lockerId: string; durationHours: number; lockerNumber: number; bookingId?: string }) => {
  if (!db) throw new Error('Your locker service is not available right now.')

  const auth = getAuth()
  const user = auth.currentUser
  if (!user) throw new Error('Please log in to continue.')

  const sameUserBookings = await loadUserBookingsForPayment(user.uid)
  const existing = sameUserBookings.find((booking) => {
    if (booking.lockerId !== payload.lockerId) return false
    const status = String(booking.paymentStatus || '').toUpperCase()
    if (status === 'PENDING') return true
    if (status === 'PAID') {
      const endTime = booking.rentalEnd ? new Date(booking.rentalEnd).getTime() : 0
      return endTime > Date.now()
    }
    return false
  })

  if (existing) {
    return { id: existing.id, paymentStatus: String(existing.paymentStatus || 'PENDING'), isExisting: true }
  }

  const activeOtherBookings = await getDocs(
    query(
      collection(db!, 'bookings'),
      where('lockerId', '==', payload.lockerId),
      where('paymentStatus', '==', 'PAID')
    )
  )

  const competingActiveBooking = activeOtherBookings.docs.find((bookingDoc) => {
    const booking = bookingDoc.data() as any
    const endTime = booking.rentalEnd ? new Date(booking.rentalEnd).getTime() : 0
    return endTime > Date.now()
  })

  if (competingActiveBooking) {
    throw new Error('Sorry, this locker has just been booked by another customer. Please choose another locker.')
  }

  const result = await runTransaction(db, async (transaction) => {
    const lockerRef = doc(db, 'lockers', payload.lockerId)
    const lockerSnap = await transaction.get(lockerRef)

    if (!lockerSnap.exists()) {
      throw new Error('Locker not found. Please try again.')
    }

    const locker = lockerSnap.data() as any
    const lockerStatus = String(locker.status || '').toUpperCase()

    if (locker.isOccupied === true && locker.bookingId && locker.rentalEnd) {
      const rentalEndTime = new Date(locker.rentalEnd).getTime()
      if (rentalEndTime > Date.now()) {
        throw new Error('Sorry, this locker has just been booked by another customer. Please choose another locker.')
      }
    }

    if (lockerStatus !== 'AVAILABLE' && lockerStatus !== 'CLOSED') {
      throw new Error('This locker is not available for booking. Please choose another locker.')
    }

    const rentalStart = new Date()
    const rentalEnd = new Date(rentalStart.getTime() + payload.durationHours * 60 * 60 * 1000)
    const bookingId = `booking-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const accessCode = generateAccessCode()

    const bookingData = {
      userId: user.uid,
      lockerId: payload.lockerId,
      customerName: user.displayName || 'Customer',
      customerEmail: user.email || '',
      rentalHours: Number(payload.durationHours),
      pricePerHour: 2,
      totalPrice: Number((payload.durationHours * 2).toFixed(2)),
      accessCode,
      paymentStatus: 'PENDING',
      rentalStart: rentalStart.toISOString(),
      rentalEnd: rentalEnd.toISOString(),
      createdAt: serverTimestamp(),
      lockerStatus: 'BOOKED',
      bookingId,
      lockerNumber: Number(payload.lockerNumber || locker.lockerNumber || 1),
      paymentReference: 'DEMO PAYMENT'
    }

    const bookingRef = doc(db, 'bookings', bookingId)
    transaction.set(bookingRef, bookingData)

    transaction.update(lockerRef, {
      status: 'BOOKED',
      isOpen: false,
      isOccupied: true,
      bookingId,
      userId: user.uid,
      accessCode,
      rentalStart: rentalStart.toISOString(),
      rentalEnd: rentalEnd.toISOString(),
      lastUpdated: serverTimestamp()
    })

    return { id: bookingId, paymentStatus: 'PENDING', isExisting: false }
  })

  return result
}

export const createCheckout = async (payload: { lockerId: string; durationHours: number; bookingId?: string }) => {
  console.log('[PAYMENT] started')

  try {
    if (!db) throw new Error('Your locker service is not available right now.')

    const auth = getAuth()
    const user = auth.currentUser
    if (!user) throw new Error('Please log in to continue.')

    const bookings = await loadUserBookingsForPayment(user.uid)
    const existingBooking = (payload.bookingId ? bookings.find((booking) => booking.id === payload.bookingId) : null)
      || bookings.find((booking) => booking.lockerId === payload.lockerId && String(booking.paymentStatus || '').toUpperCase() === 'PENDING')
      || bookings.find((booking) => {
        if (booking.lockerId !== payload.lockerId || !isPaidStatus(booking.paymentStatus)) return false
        const endTime = booking.rentalEnd ? new Date(booking.rentalEnd).getTime() : 0
        return endTime > Date.now()
      })

    if (!existingBooking) {
      throw new Error('No existing booking was found for this payment.')
    }

    const bookingId = existingBooking.id
    console.log('[PAYMENT] booking id:', bookingId)

    if (isPaidStatus(existingBooking.paymentStatus)) {
      console.log('[PAYMENT] payment already complete')
      return paidCheckoutResult(bookingId, 'Payment already completed for this booking.')
    }

    // Use transaction to ensure booking and locker stay in sync.
    // IMPORTANT: all reads happen before any writes inside the same transaction.
    await runTransaction(db, async (transaction) => {
      const bookingRef = doc(db, 'bookings', bookingId)
      const lockerRef = doc(db, 'lockers', payload.lockerId)

      // Read all required documents before any writes in this transaction.
      const bookingSnap = await transaction.get(bookingRef)
      if (!bookingSnap.exists()) {
        throw new Error('Booking not found.')
      }

      const booking = bookingSnap.data() as any
      if (booking.paymentStatus === 'PAID') {
        return // Already paid
      }

      const lockerSnap = await transaction.get(lockerRef)
      if (!lockerSnap.exists()) {
        console.warn('[PAYMENT] Locker document does not exist:', payload.lockerId)
        throw new Error('Locker not found. Please try again.')
      }

      const locker = lockerSnap.data() as any
      const lockerStatus = String(locker.status || '').toUpperCase()

      // Do not perform any read of the booking or locker after this point.
      // All required reads have already been completed before the writes.
      if (lockerStatus === 'AVAILABLE' || lockerStatus === 'CLOSED' || lockerStatus === 'BOOKED') {
        transaction.update(lockerRef, {
          status: 'BOOKED',
          isOpen: false,
          isOccupied: true,
          bookingId,
          userId: user.uid,
          accessCode: booking.accessCode || generateAccessCode(),
          rentalStart: booking.rentalStart || new Date().toISOString(),
          rentalEnd: booking.rentalEnd || new Date(Date.now() + payload.durationHours * 60 * 60 * 1000).toISOString(),
          lastUpdated: serverTimestamp()
        })
        console.log('[PAYMENT] locker ensured BOOKED status')
      }

      transaction.update(bookingRef, {
        paymentStatus: 'PAID',
        paymentDate: serverTimestamp()
      })

      console.log('[PAYMENT] booking updated to PAID')
    })

    console.log('[PAYMENT] payment complete')
    return paidCheckoutResult(bookingId, 'Payment successful! Your locker has been booked.')
  } catch (error: any) {
    logPaymentError(error)
    throw error
  }
}

export const getReceipt = async (payload: { bookingId?: string; rentalId?: string; sessionId?: string }) => {
  if (!db) throw new Error('Your locker service is not available right now.')

  const auth = getAuth()
  const user = auth.currentUser
  if (!user) throw new Error('Please log in to continue.')

  const bookingId = payload.bookingId || payload.rentalId
  if (!bookingId) throw new Error('Receipt is not ready yet.')

  const bookingSnap = await getDoc(doc(db, 'bookings', bookingId))
  if (!bookingSnap.exists()) throw new Error('Your receipt is not ready yet.')

  const booking = bookingSnap.data() as any
  if (booking.userId !== user.uid) throw new Error('You can only view your own booking.')

  const start = booking.rentalStart ? toDate(booking.rentalStart) : new Date()
  const end = booking.rentalEnd ? toDate(booking.rentalEnd) : new Date(start.getTime() + Number(booking.rentalHours || 1) * 60 * 60 * 1000)
  const paymentDate = booking.paymentDate ? toDate(booking.paymentDate) : new Date()

  return {
    data: {
      id: bookingSnap.id,
      bookingId: bookingSnap.id,
      receiptNumber: `SML-${bookingSnap.id.slice(-8).toUpperCase()}`,
      customerName: booking.customerName,
      customerEmail: booking.customerEmail,
      lockerNumber: Number(booking.lockerNumber || 1),
      durationHours: Number(booking.rentalHours || 1),
      startTime: Timestamp.fromDate(start),
      expiryTime: Timestamp.fromDate(end),
      amount: Number(booking.totalPrice || 0),
      paymentStatus: booking.paymentStatus || 'PAID',
      paymentReference: booking.paymentReference || 'DEMO PAYMENT',
      accessCode: booking.accessCode,
      codes: [booking.accessCode],
      receiptDate: paymentDate.toISOString(),
      lockerId: booking.lockerId,
      userId: booking.userId,
      pricePerHour: Number(booking.pricePerHour || 2),
      totalHours: Number(booking.rentalHours || 1),
      paymentDate: paymentDate.toISOString(),
      rentalStart: booking.rentalStart,
      rentalEnd: booking.rentalEnd
    }
  }
}

export const verifyAccessCode = async (payload: { rentalId: string; lockerId: string; code: string }) => {
  if (!db) throw new Error('Your locker service is not available right now.')

  const auth = getAuth()
  const user = auth.currentUser
  if (!user) throw new Error('Please log in to continue.')

  const bookingRef = doc(db, 'bookings', payload.rentalId)
  const bookingSnap = await getDoc(bookingRef)
  if (!bookingSnap.exists()) throw new Error('Your booking could not be found.')

  const booking = bookingSnap.data() as any
  if (booking.userId !== user.uid || booking.lockerId !== payload.lockerId) {
    throw new Error('This locker is not linked to your account.')
  }

  const expiryTime = new Date(booking.rentalEnd).getTime()
  if (Date.now() > expiryTime) {
    await updateDoc(doc(db, 'lockers', payload.lockerId), {
      status: 'AVAILABLE',
      isOpen: false,
      isOccupied: false,
      bookingId: '',
      userId: '',
      accessCode: '',
      rentalStart: null,
      rentalEnd: null,
      lastUpdated: Date.now()
    })

    await updateDoc(bookingRef, {
      paymentStatus: 'EXPIRED',
      lockerStatus: 'EXPIRED'
    })

    throw new Error('Your rental has ended. Please book again.')
  }

  if (String(booking.accessCode).trim() !== String(payload.code).trim()) {
    throw new Error('The access code is not correct.')
  }

  const lockerRef = doc(db, 'lockers', payload.lockerId)
  const lockerSnap = await getDoc(lockerRef)
  const locker = lockerSnap.data() as any
  if (!lockerSnap.exists() || String(locker.bookingId || '') !== String(payload.rentalId) || String(locker.userId || '') !== String(user.uid)) {
    throw new Error('This locker is not linked to your active booking.')
  }

  await updateDoc(lockerRef, {
    status: 'OPEN',
    isOpen: true,
    isOccupied: true,
    bookingId: payload.rentalId,
    userId: user.uid,
    accessCode: booking.accessCode,
    rentalStart: booking.rentalStart,
    rentalEnd: booking.rentalEnd,
    lastUpdated: Date.now()
  })

  return {
    data: {
      granted: true,
      message: 'Your locker is ready!'
    }
  }
}

export const closeLockerForBooking = async (payload: { bookingId: string; lockerId: string }) => {
  if (!db) throw new Error('Your locker service is not available right now.')

  const auth = getAuth()
  const user = auth.currentUser
  if (!user) throw new Error('Please log in to continue.')

  const bookingRef = doc(db, 'bookings', payload.bookingId)
  const bookingSnap = await getDoc(bookingRef)
  if (!bookingSnap.exists()) throw new Error('Your booking could not be found.')

  const booking = bookingSnap.data() as any
  if (booking.userId !== user.uid || booking.lockerId !== payload.lockerId) {
    throw new Error('This locker is not linked to your account.')
  }

  const expiryTime = new Date(booking.rentalEnd).getTime()
  if (Date.now() > expiryTime) {
    throw new Error('Your rental has ended. Please book again.')
  }

  const lockerRef = doc(db, 'lockers', payload.lockerId)
  const lockerSnap = await getDoc(lockerRef)
  if (!lockerSnap.exists()) throw new Error('This locker is no longer available.')

  const locker = lockerSnap.data() as any
  if (String(locker.bookingId || '') !== String(payload.bookingId) || String(locker.userId || '') !== String(user.uid)) {
    throw new Error('This locker is not linked to your active booking.')
  }

  await updateDoc(lockerRef, {
    status: 'CLOSED',
    isOpen: false,
    isOccupied: true,
    bookingId: payload.bookingId,
    userId: user.uid,
    accessCode: booking.accessCode,
    rentalStart: booking.rentalStart,
    rentalEnd: booking.rentalEnd,
    lastUpdated: Date.now()
  })

  return {
    data: {
      granted: true,
      message: 'Locker closed.'
    }
  }
}

export const submitReview = async (payload: { rating: number; review: string }) => {
  const auth = getAuth()
  const user = auth.currentUser
  if (!user) throw new Error('Please log in to continue.')

  if (!db) throw new Error('Your locker service is not available right now.')

  const reviewId = `review-${Date.now()}`
  await setDoc(doc(db, 'reviews', reviewId), {
    userId: user.uid,
    name: user.displayName || 'Customer',
    rating: payload.rating,
    review: payload.review,
    createdAt: new Date().toISOString(),
    status: 'approved'
  })

  return { data: { id: reviewId } }
}

export const submitContact = async (payload: { name: string; email: string; phone: string; message: string }) => {
  if (!db) throw new Error('Your locker service is not available right now.')

  const contactId = `contact-${Date.now()}`
  await setDoc(doc(db, 'contacts', contactId), {
    ...payload,
    status: 'new',
    createdAt: new Date().toISOString()
  })

  return { data: { id: contactId } }
}
