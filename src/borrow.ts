import { formatErrorMessages } from "./error";
import {
  Expr,
  PathCollection,
  pathCollectionConflictsWithPathCollection,
} from "./expr";
import { isMutRefType, MutRefType, RefType } from "./type-checker";

export interface Borrowing {
  expr: Expr;
  type: RefType | MutRefType;
  pathCollection: PathCollection;
}

export function checkBorrowings(borrowings: Borrowing[]): void {
  const mutableBorrowings = borrowings.filter((b) => isMutRefType(b.type));

  for (let i = 0; i < borrowings.length; i++) {
    const borrowing = borrowings[i]!;

    for (let j = 0; j < mutableBorrowings.length; j++) {
      const mutableBorrowing = mutableBorrowings[j]!;
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

        throw formatErrorMessages({
          modulePath: borrowing.expr.$!.env.modulePath,
          inputString: borrowing.expr.$!.env.inputString,
          tokenAndErrorList: [
            {
              errorMessage: `Borrowing conflict detected`,
              token: borrowing2.expr.token,
            },
            {
              errorMessage: `Previous borrowing`,
              token: borrowing1.expr.token,
            },
          ],
        });
      }
    }
  }
}
