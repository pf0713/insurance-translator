const AUTH_TOKEN = 'insurance-translator-dev-2024';

App({
  onLaunch() {
    // 全局注入 auth header，所有 wx.request 自动带 token
    const _request = wx.request;
    wx.request = function (options) {
      options.header = Object.assign({}, options.header, {
        'Authorization': 'Bearer ' + AUTH_TOKEN,
      });
      return _request.call(wx, options);
    };
  }
});
