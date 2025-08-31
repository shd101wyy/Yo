import { formatErrorMessages } from "./error";
import {
  Expr,
  exprToString,
  PathCollection,
  pathCollectionConflictsWithPathCollection,
} from "./expr";
import {
  FunctionType,
  isMutRefType,
  MutRefType,
  RefType,
  typeToString,
} from "./types";

export interface Borrowing {
  /**
   * The experssion that is borrowing a value. For example
   *   &(x), &!(p.x)
   */
  expr: Expr;

  /**
   * The type of the borrowing. It can be a reference type, mutable reference type, or closure type.
   */
  type: RefType | MutRefType | (FunctionType & { isClosure: true });

  /**
   * Path collection of the borrowing. It represents the paths that are borrowed.
   */
  pathCollection: PathCollection;
}

export function checkBorrowings(borrowings: Borrowing[], expr?: Expr): void {
  const mutableBorrowings = borrowings.filter((b) => isMutRefType(b.type));
  for (let i = 0; i < mutableBorrowings.length; i++) {
    const mutableBorrowing = mutableBorrowings[i]!;

    // Check against all other borrowings
    for (let j = 0; j < borrowings.length; j++) {
      const borrowing = borrowings[j]!;
      if (borrowing === mutableBorrowing) {
        continue; // Skip if it's the same borrowing
      }

      // Check if there is path conflicts
      if (
        pathCollectionConflictsWithPathCollection(
          mutableBorrowing.pathCollection,
          borrowing.pathCollection
        )
      ) {
        // compare the token of mutaleBorrowing and borrowing
        // to determine which the order of their declaration
        let borrowing1: Borrowing;
        let borrowing2: Borrowing;

        if (
          mutableBorrowing.expr.token.position.character <
          borrowing.expr.token.position.character
        ) {
          borrowing1 = mutableBorrowing;
          borrowing2 = borrowing;
        } else {
          borrowing1 = borrowing;
          borrowing2 = mutableBorrowing;
        }

        throw formatErrorMessages([
          {
            errorMessage: `Borrow conflict detected`,
            token: borrowing2.expr.token,
          },
          {
            errorMessage: `Previous borrowed at`,
            token: borrowing1.expr.token,
          },
        ]);
      }
    }
  }

  // Check against expr if provided
  if (expr && expr.$) {
    for (let i = 0; i < borrowings.length; i++) {
      const borrowing = borrowings[i]!;
      if (
        pathCollectionConflictsWithPathCollection(
          borrowing.pathCollection,
          expr.$.pathCollection
        )
      ) {
        throw formatErrorMessages([
          {
            errorMessage: `Borrow conflict detected`,
            token: expr.token,
          },
          {
            errorMessage: `Previous borrowed at`,
            token: borrowing.expr.token,
          },
        ]);
      }
    }
  }
}

function pathCollectionToString(pathCollection: PathCollection): string {
  return "- " + pathCollection.map((p) => p.join(" -> ")).join(";\n- ");
}

export function borrowingsToString(borrowings: Borrowing[]): string {
  return borrowings
    .map(
      (b) =>
        `Borrowing: ${exprToString(b.expr)} as ${typeToString(b.type)} at:
${pathCollectionToString(b.pathCollection)}`
    )
    .join("\n");
}
