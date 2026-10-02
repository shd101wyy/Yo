/* Fixture for tests/basic.test.yo's "named after header macros" tests.
 *
 * A header may define a macro of any spelling, lower-case included:
 * <openssl/asn1.h> defines `ub_name` exactly like this, and the compiler's
 * own Yo local of that name stopped the C compile
 * (issues/fixed/emitted-c-identifiers-collide-with-header-macros.md).
 * Every Yo local, parameter and field is emitted under a prefix no header
 * defines, so a program that includes this header still compiles and reads
 * its own values.
 *
 * It lives beside the test on purpose: the test batch's generated .c is
 * emitted in this directory, so the quoted include resolves with no -I.
 */
#ifndef YO_TEST_HEADER_MACRO_NAMES_H
#define YO_TEST_HEADER_MACRO_NAMES_H

#define ub_name 32768
#define yo_hm_count (40 + 2)

static inline int yo_hm_ub_name(void) { return ub_name; }

#endif
