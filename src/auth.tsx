import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  type User
} from 'firebase/auth'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { auth, db } from './firebase'

interface AuthContextValue {
  user: User | null
  loading: boolean
  signUp: (name: string, email: string, password: string, confirmPassword: string, phone?: string) => Promise<void>
  login: (email: string, password: string) => Promise<void>
  resetPassword: (email: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth!, (currentUser) => {
      setUser(currentUser)
      setLoading(false)
    })

    return unsubscribe
  }, [])

  async function signUp(name: string, email: string, password: string, confirmPassword: string, phone?: string) {
    if (!name || !email || !password) throw new Error('Please enter your name, email address, and password.')
    if (password.length < 6) throw new Error('Your password must be at least 6 characters long.')
    if (password !== confirmPassword) throw new Error('Passwords do not match.')

    const result = await createUserWithEmailAndPassword(auth!, email, password)
    await updateProfile(result.user, { displayName: name })
    await setDoc(doc(db!, 'users', result.user.uid), {
      name,
      email,
      phone: phone || '',
      role: 'customer',
      createdAt: new Date().toISOString()
    })
  }

  return (
    <AuthContext.Provider value={{
      user,
      loading,
      signUp,
      login: async (email, password) => {
        await signInWithEmailAndPassword(auth!, email, password)
      },
      resetPassword: async (email) => {
        if (!email.trim()) throw new Error('Please enter your email address to reset your password.')

        try {
          await sendPasswordResetEmail(auth!, email)
        } catch (error: any) {
          if (error?.code === 'auth/user-not-found') {
            return
          }
          throw error
        }
      },
      logout: async () => {
        await signOut(auth!)
      }
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('AuthProvider missing')
  return ctx
}

export async function getProfile(uid: string) {
  const snap = await getDoc(doc(db!, 'users', uid))
  return snap.exists() ? snap.data() : null
}
