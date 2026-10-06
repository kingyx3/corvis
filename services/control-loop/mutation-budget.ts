/** Budgets count attempted logical mutations, including uncertain/partial writes. */
export function validateMutationBudget(budget: number): number {
  if (!Number.isSafeInteger(budget) || budget < 0) {
    throw new Error("mutation_budget_must_be_a_nonnegative_safe_integer");
  }
  return budget;
}
