import type { InputHTMLAttributes } from 'react';

type ExactTextInputProps = Pick<
  InputHTMLAttributes<HTMLInputElement>,
  'autoCapitalize' | 'autoCorrect' | 'spellCheck'
>;

/**
 * iOS Safari capitalizes the first letter of a text input by default
 * (`autocapitalize="sentences"`). Identity values such as usernames must
 * stay exactly as typed.
 */
export const exactTextInputProps: ExactTextInputProps = {
  autoCapitalize: 'none',
  autoCorrect: 'off',
  spellCheck: false,
};

export const usernameInputProps = {
  ...exactTextInputProps,
  autoComplete: 'username' as const,
};
