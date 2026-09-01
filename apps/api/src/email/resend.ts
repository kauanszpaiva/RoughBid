export type ClassPassWelcomeInput = {
  to: string;
  appUrl: string;
};

export type ClassPassWelcomeEmail = {
  to: string;
  templateAlias: 'roughbid-class-pass-welcome';
  variables: {
    APP_URL: string;
    CLASS_PASS_DAYS: 60;
  };
};

export function createClassPassWelcomeEmail(input: ClassPassWelcomeInput): ClassPassWelcomeEmail {
  if (!input.to.includes('@')) throw new Error('A valid recipient email is required.');
  const appUrl = new URL(input.appUrl);
  if (appUrl.protocol !== 'https:') throw new Error('App URL must use HTTPS.');
  return {
    to: input.to,
    templateAlias: 'roughbid-class-pass-welcome',
    variables: {
      APP_URL: appUrl.toString().replace(/\/$/, ''),
      CLASS_PASS_DAYS: 60,
    },
  };
}
