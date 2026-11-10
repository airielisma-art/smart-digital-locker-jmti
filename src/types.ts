export type LockerStatus = 'available' | 'booked' | 'open' | 'closed' | 'occupied' | 'maintenance' | 'expired' | 'offline'
export type RentalStatus = 'pending' | 'active' | 'expired' | 'cancelled'
export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'expired' | 'refunded'

export interface Locker {
  id: string
  lockerNumber: number
  status: LockerStatus
  hardwareId: string
  hourlyRate: number
  isOpen?: boolean
  isOccupied?: boolean
  bookingId?: string
  userId?: string
  accessCode?: string
  rentalStart?: number | null
  rentalEnd?: number | null
  lastUpdated?: number
}

export interface Rental {
  id: string
  userId: string
  lockerId: string
  lockerNumber: number
  startTime: { seconds: number }
  expiryTime: { seconds: number }
  status: RentalStatus
  paymentStatus: PaymentStatus
  amount: number
  reminderSent?: boolean
  accessStatus?: string
}
