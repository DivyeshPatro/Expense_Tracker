// Seed category set (PRD §4.3) with the prototype's icons & colors, plus the
// common-merchant dictionary that seeds rule-based auto-categorization.

export interface CategoryMeta {
  name: string;
  kind: "EXPENSE" | "INCOME";
  icon: string;
  color: string;
}

export const DEFAULT_CATEGORIES: CategoryMeta[] = [
  { name: "Food", kind: "EXPENSE", icon: "🍔", color: "#e07b39" },
  { name: "Groceries", kind: "EXPENSE", icon: "🛒", color: "#7c3aed" },
  { name: "Rent", kind: "EXPENSE", icon: "🏠", color: "#2a63f6" },
  { name: "Electricity", kind: "EXPENSE", icon: "⚡", color: "#b97d10" },
  { name: "Water", kind: "EXPENSE", icon: "💧", color: "#0e7490" },
  { name: "Gas", kind: "EXPENSE", icon: "🔥", color: "#dc6b2f" },
  { name: "Internet", kind: "EXPENSE", icon: "🌐", color: "#0e7490" },
  { name: "Fuel", kind: "EXPENSE", icon: "⛽", color: "#57534e" },
  { name: "Shopping", kind: "EXPENSE", icon: "🛍️", color: "#d1497e" },
  { name: "Medical", kind: "EXPENSE", icon: "💊", color: "#dc2626" },
  { name: "Travel", kind: "EXPENSE", icon: "🚕", color: "#0f766e" },
  { name: "Entertainment", kind: "EXPENSE", icon: "🎬", color: "#6d5ae6" },
  { name: "Education", kind: "EXPENSE", icon: "📚", color: "#1d4ed8" },
  { name: "Insurance", kind: "EXPENSE", icon: "🛡️", color: "#475569" },
  { name: "Investment", kind: "EXPENSE", icon: "📈", color: "#149356" },
  { name: "EMI", kind: "EXPENSE", icon: "🏦", color: "#334155" },
  { name: "Subscription", kind: "EXPENSE", icon: "📺", color: "#9333ea" },
  { name: "Misc", kind: "EXPENSE", icon: "📦", color: "#78716c" },
  { name: "Salary", kind: "INCOME", icon: "💼", color: "#149356" },
  { name: "Bonus", kind: "INCOME", icon: "🎁", color: "#149356" },
  { name: "Freelance", kind: "INCOME", icon: "💻", color: "#0f766e" },
  { name: "Cashback", kind: "INCOME", icon: "🪙", color: "#b97d10" },
  { name: "Interest", kind: "INCOME", icon: "🏛️", color: "#334155" },
  { name: "Refund", kind: "INCOME", icon: "↩️", color: "#64748b" },
  { name: "Gift", kind: "INCOME", icon: "🎀", color: "#d1497e" },
  { name: "Rental", kind: "INCOME", icon: "🏠", color: "#2a63f6" },
  { name: "Investment returns", kind: "INCOME", icon: "📈", color: "#149356" },
  { name: "Other", kind: "INCOME", icon: "📦", color: "#78716c" },
];

export const TRANSFER_META = { icon: "⇄", color: "#64748b" };

/** Fallback meta when a transaction has no category. */
export const MISC_META = { icon: "📦", color: "#78716c" };

// Deterministic merchant → category seed dictionary (normalized lowercase keys).
export const MERCHANT_DICTIONARY: Record<string, string> = {
  swiggy: "Food",
  zomato: "Food",
  "eatsure": "Food",
  bigbasket: "Groceries",
  blinkit: "Groceries",
  zepto: "Groceries",
  dmart: "Groceries",
  bescom: "Electricity",
  "act fibernet": "Internet",
  airtel: "Internet",
  jio: "Subscription",
  netflix: "Subscription",
  spotify: "Subscription",
  hotstar: "Subscription",
  uber: "Travel",
  ola: "Travel",
  rapido: "Travel",
  irctc: "Travel",
  amazon: "Shopping",
  flipkart: "Shopping",
  myntra: "Shopping",
  apollo: "Medical",
  pharmeasy: "Medical",
  "1mg": "Medical",
  bookmyshow: "Entertainment",
  pvr: "Entertainment",
  inox: "Entertainment",
  hpcl: "Fuel",
  "indian oil": "Fuel",
  shell: "Fuel",
};

export const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  BANK: "Bank account",
  CASH: "Cash",
  WALLET: "UPI wallet",
  CREDIT_CARD: "Credit card",
  INVESTMENT: "Investment",
};
