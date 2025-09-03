export const SEL = {
  login: {
    user: 'input[name="_username"], input[name="username"], input#username, input[name="login"], input#login, input[type="email"], input[type="text"]',
    pass: 'input[name="_password"], input[name="password"], input#password, input[type="password"]',
    submit: 'input[type="submit"][value="Войти"], button[type="submit"], input[type="submit"]'
  },
  nav: {
    servicesSection: 'a, span',
    ringGroupsLinkText: 'Группы обзвона'
  },
  groups: {
    filterInput: 'input[type="search"], input[name="search"]',
    openGroupButton: 'a[href*="group"], button:has-text("Открыть")'
  },
  edit: {
    // списки
    availableListItems: 'div.grp-list-content ul.grp-list li',
    membersListItems: 'div.grp-box:nth-of-type(2) div.grp-list-content ul.grp-list li'
    // Кнопки больше не задаём CSS’ом — кликаем по тексту через XPath
  }
};
